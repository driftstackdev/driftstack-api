package driftstack

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
	"time"
)

// DefaultWebhookTolerance is the maximum age a Driftstack signature
// timestamp may have before VerifyWebhookSignature rejects it.
const DefaultWebhookTolerance = 5 * time.Minute

// VerifyWebhookOptions tunes signature verification.
type VerifyWebhookOptions struct {
	// Tolerance is the max clock skew between server-issued timestamp
	// and "now". Default DefaultWebhookTolerance.
	Tolerance time.Duration
	// Now overrides time.Now for tests.
	Now time.Time
	// HeaderPrev is an OPTIONAL fallback for a separately-supplied
	// previous-secret signature. Driftstack does NOT emit a separate
	// header: during a rotation grace window the previous-secret HMAC
	// is included as a second v1= inside the main X-Driftstack-Signature
	// header (t=,v1=<new>,v1=<old>), which the verifier already checks.
	// So passing `header` alone verifies rotation deliveries correctly
	// and this input is rarely needed. When set, VerifyWebhookSignature
	// accepts EITHER `header` OR `HeaderPrev` matching `secret`. V-359.
	HeaderPrev string
}

// VerifyWebhookSignature returns true iff the X-Driftstack-Signature
// header on an inbound request is well-formed, the timestamp is within
// tolerance, and the HMAC matches in constant time. Never panics;
// returns false on any failure mode.
//
// Header format (Stripe-style): t=<unix-seconds>,v1=<hex hmac>.
// HMAC = HMAC-SHA256(<unix-seconds>.<raw body>, <webhook secret>).
//
// body must be the EXACT raw bytes the server signed. If your HTTP
// router middleware re-encodes JSON before your handler runs, you'll
// need to use a raw-body access path (e.g. read req.Body once and
// preserve it).
//
// V-359 — Driftstack does NOT emit a separate prev header: during a
// rotation grace window the previous-secret HMAC arrives as a second
// v1= inside the same X-Driftstack-Signature header, which is already
// verified above, so passing `header` alone covers rotation. The
// optional VerifyWebhookOptions.HeaderPrev is a rarely-needed fallback
// for a separately-supplied previous-secret signature; when set, the
// verifier accepts either header matching `secret`.
func VerifyWebhookSignature(body []byte, header string, secret string, opts ...VerifyWebhookOptions) bool {
	// V-2010 — refuse before hashing when the signing secret is empty. Go's
	// hmac.New accepts a zero-length key and returns a perfectly good digest, so
	// without this an attacker who knows the body and timestamp computes
	// HMAC-SHA256("", "<t>.<body>") and it verifies. Measured: that exact input
	// returned true. The doc above promises "returns false on any failure mode";
	// an empty secret is one.
	if secret == "" {
		return false
	}

	tolerance := DefaultWebhookTolerance
	now := time.Now()
	headerPrev := ""
	if len(opts) > 0 {
		if opts[0].Tolerance > 0 {
			tolerance = opts[0].Tolerance
		}
		if !opts[0].Now.IsZero() {
			now = opts[0].Now
		}
		headerPrev = opts[0].HeaderPrev
	}

	if verifySingleHeader(body, header, secret, tolerance, now) {
		return true
	}
	if headerPrev != "" && verifySingleHeader(body, headerPrev, secret, tolerance, now) {
		return true
	}
	return false
}

func verifySingleHeader(body []byte, header string, secret string, tolerance time.Duration, now time.Time) bool {
	if header == "" {
		return false
	}
	parsed, ok := parseSignatureHeader(header)
	if !ok {
		return false
	}
	signed := time.Unix(parsed.timestampSeconds, 0)
	delta := now.Sub(signed)
	if delta < 0 {
		delta = -delta
	}
	if delta > tolerance {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strconv.FormatInt(parsed.timestampSeconds, 10)))
	mac.Write([]byte("."))
	mac.Write(body)
	expectedSum := mac.Sum(nil)
	// Accept if our computed HMAC matches ANY of the header's v1= signatures
	// (constant-time per candidate). During a secret-rotation grace window the
	// server dual-signs into one header (t=,v1=<new>,v1=<old>), so a verifier
	// holding either the new or the old secret passes.
	for _, sigHex := range parsed.signatureHexes {
		gotSum, err := hex.DecodeString(sigHex)
		if err != nil {
			continue
		}
		if hmac.Equal(expectedSum, gotSum) {
			return true
		}
	}
	return false
}

type parsedSignature struct {
	timestampSeconds int64
	signatureHexes   []string
}

func parseSignatureHeader(header string) (parsedSignature, bool) {
	var ts int64
	var sigs []string
	tsSet := false
	for _, part := range strings.Split(header, ",") {
		eq := strings.IndexByte(part, '=')
		if eq < 0 {
			continue
		}
		key := strings.TrimSpace(part[:eq])
		val := strings.TrimSpace(part[eq+1:])
		switch key {
		case "t":
			n, err := strconv.ParseInt(val, 10, 64)
			if err == nil {
				ts = n
				tsSet = true
			}
		case "v1":
			if val != "" {
				sigs = append(sigs, val)
			}
		}
	}
	if !tsSet || len(sigs) == 0 {
		return parsedSignature{}, false
	}
	return parsedSignature{timestampSeconds: ts, signatureHexes: sigs}, true
}
