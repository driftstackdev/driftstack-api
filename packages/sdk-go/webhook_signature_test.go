package driftstack

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
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

func sigHex(body []byte, secret string, ts int64) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strconv.FormatInt(ts, 10)))
	mac.Write([]byte("."))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

// During a secret-rotation grace window the server dual-signs into ONE
// header (t=,v1=<new>,v1=<old>); a verifier holding EITHER secret must pass.
func TestVerifyWebhookSignature_DualV1Rotation(t *testing.T) {
	body := []byte(`{"event":"x"}`)
	now := time.Now()
	ts := now.Unix()
	const newSecret = "whsec_new_rotated"
	const oldSecret = "whsec_old_pre_rotation"
	header := "t=" + strconv.FormatInt(ts, 10) + ",v1=" + sigHex(body, newSecret, ts) + ",v1=" + sigHex(body, oldSecret, ts)
	if !VerifyWebhookSignature(body, header, newSecret, VerifyWebhookOptions{Now: now}) {
		t.Error("new-secret holder should verify (first v1=, previously discarded)")
	}
	if !VerifyWebhookSignature(body, header, oldSecret, VerifyWebhookOptions{Now: now}) {
		t.Error("old-secret holder should verify (last v1=)")
	}
	if VerifyWebhookSignature(body, header, "whsec_unrelated", VerifyWebhookOptions{Now: now}) {
		t.Error("unrelated secret must not verify against any v1=")
	}
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

// The skew comparison is exclusive, so the boundary itself is inside the window. The
// two arms above sit ten minutes out against a five-minute tolerance — nowhere near
// the edge — so an operator flip or a widened window passes both. These bracket it on
// each side. sdk-typescript and sdk-python carry the same points, because a customer
// picks one SDK and gets whatever that one enforces.
func TestVerifyWebhookSignature_AtToleranceEdge(t *testing.T) {
	t.Parallel()
	body := []byte("edge")
	secret := "whsec_xx"
	now := time.Now().Truncate(time.Second)
	atEdge := now.Add(-DefaultWebhookTolerance)
	header := sign(body, secret, atEdge.Unix())
	if !VerifyWebhookSignature(body, header, secret, VerifyWebhookOptions{Now: now}) {
		t.Fatal("expected a signature exactly at the tolerance edge to pass")
	}
}

func TestVerifyWebhookSignature_OneSecondBeyondEdge(t *testing.T) {
	t.Parallel()
	body := []byte("edge")
	secret := "whsec_xx"
	now := time.Now().Truncate(time.Second)
	beyond := now.Add(-DefaultWebhookTolerance - time.Second)
	header := sign(body, secret, beyond.Unix())
	if VerifyWebhookSignature(body, header, secret, VerifyWebhookOptions{Now: now}) {
		t.Fatal("expected a signature one second past the edge to fail")
	}
}

func TestVerifyWebhookSignature_OneSecondBeyondEdgeInTheFuture(t *testing.T) {
	t.Parallel()
	body := []byte("edge")
	secret := "whsec_xx"
	now := time.Now().Truncate(time.Second)
	beyond := now.Add(DefaultWebhookTolerance + time.Second)
	header := sign(body, secret, beyond.Unix())
	if VerifyWebhookSignature(body, header, secret, VerifyWebhookOptions{Now: now}) {
		t.Fatal("expected a future signature one second past the edge to fail")
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

// Hex is case-insensitive, so the verifier must be too. The comparison decodes
// both sides before checking, which is what makes casing irrelevant.
//
// Guarded here because it was not: replacing the decode with a hex-TEXT compare
// leaves every other arm in this file green. sdk-python carried exactly that
// shape and was the only one of the three to refuse an upper-case signature for
// the same body, secret and timestamp — a webhook one customer verified was one
// their neighbour could not.
//
// Nothing is weakened: the HMAC still has to match byte for byte via hmac.Equal.
// This API signs lowercase, so other casings arrive from a proxy or a
// hand-built request.
func TestVerifyWebhookSignature_UpperCaseHexAccepted(t *testing.T) {
	body := []byte(`{"event":"x"}`)
	secret := "whsec_case"
	ts := time.Now().Unix()
	header := "t=" + strconv.FormatInt(ts, 10) + ",v1=" + strings.ToUpper(sigHex(body, secret, ts))
	if !VerifyWebhookSignature(body, header, secret) {
		t.Fatal("an upper-case signature was refused; hex encodes the same bytes either way")
	}
}

func TestVerifyWebhookSignature_MixedCaseHexAccepted(t *testing.T) {
	body := []byte(`{"event":"x"}`)
	secret := "whsec_case"
	ts := time.Now().Unix()
	h := sigHex(body, secret, ts)
	mixed := []rune(h)
	for i := range mixed {
		if i%2 == 0 {
			mixed[i] = []rune(strings.ToUpper(string(mixed[i])))[0]
		}
	}
	header := "t=" + strconv.FormatInt(ts, 10) + ",v1=" + string(mixed)
	if !VerifyWebhookSignature(body, header, secret) {
		t.Fatal("a mixed-case signature was refused; this is not a second lookup table")
	}
}

// Without this, accepting everything would satisfy the two arms above.
func TestVerifyWebhookSignature_CaseInsensitivityDoesNotWeaken(t *testing.T) {
	body := []byte(`{"event":"x"}`)
	secret := "whsec_case"
	ts := time.Now().Unix()
	tsStr := strconv.FormatInt(ts, 10)

	wrong := "t=" + tsStr + ",v1=" + strings.ToUpper(sigHex(body, "whsec_other", ts))
	if VerifyWebhookSignature(body, wrong, secret) {
		t.Fatal("an upper-cased signature from the WRONG secret verified")
	}
	if VerifyWebhookSignature(body, "t="+tsStr+",v1="+strings.Repeat("z", 64), secret) {
		t.Fatal("a non-hex signature verified")
	}
	odd := sigHex(body, secret, ts)
	if VerifyWebhookSignature(body, "t="+tsStr+",v1="+odd[:len(odd)-1], secret) {
		t.Fatal("an odd-length hex signature verified")
	}
}

// V-2010 — hmac.New accepts a zero-length key and returns a perfectly good
// digest, so an attacker who knows the body and timestamp could compute
// HMAC-SHA256("", "<t>.<body>") and VerifyWebhookSignature returned true. The
// forgery below is built with the EMPTY key on purpose: a signature made with a
// real secret would be refused for the ordinary reason and prove nothing about
// this branch. The doc comment promises "returns false on any failure mode".
func TestVerifyWebhookSignature_EmptySecretRefusesEmptyKeyForgery(t *testing.T) {
	body := []byte(`{"id":"evt_1"}`)
	ts := time.Now().Unix()
	tsStr := strconv.FormatInt(ts, 10)
	mac := hmac.New(sha256.New, []byte(""))
	mac.Write([]byte(tsStr + "." + string(body)))
	forged := hex.EncodeToString(mac.Sum(nil))
	if VerifyWebhookSignature(body, "t="+tsStr+",v1="+forged, "") {
		t.Fatal("an empty secret verified an HMAC forged with the empty key")
	}
}
