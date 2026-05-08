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
	// HeaderPrev is the optional second signature header Driftstack
	// emits during the 24h secret-rotation grace window (read from
	// X-Driftstack-Signature-Prev on the inbound request). When set,
	// VerifyWebhookSignature accepts EITHER `header` OR `HeaderPrev`
	// matching `secret`, so customers who haven't rolled the new
	// secret across their verifier still pass during the rotation
	// window. V-359.
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
// V-359 — when the rotation grace is in flight, callers pass
// VerifyWebhookOptions.HeaderPrev (the second X-Driftstack-Signature-Prev
// header). The verifier accepts either header matching `secret`.
func VerifyWebhookSignature(body []byte, header string, secret string, opts ...VerifyWebhookOptions) bool {
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
	gotSum, err := hex.DecodeString(parsed.signatureHex)
	if err != nil {
		return false
	}
	return hmac.Equal(expectedSum, gotSum)
}

type parsedSignature struct {
	timestampSeconds int64
	signatureHex     string
}

func parseSignatureHeader(header string) (parsedSignature, bool) {
	var ts int64
	var sig string
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
			sig = val
		}
	}
	if !tsSet || sig == "" {
		return parsedSignature{}, false
	}
	return parsedSignature{timestampSeconds: ts, signatureHex: sig}, true
}
