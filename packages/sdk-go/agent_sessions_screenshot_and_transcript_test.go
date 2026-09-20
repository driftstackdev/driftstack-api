package driftstack

// A screenshot and the transcript can be read through the Go SDK.
//
// A "capture" step hands back a CaptureID, and the conversation lives behind an
// event stream. Neither was reachable from this SDK: a program had to write its
// own binary fetch and its own SSE reader. Each test drives the real client
// against an httptest server, so the request the SDK assembles, the way it reads
// a body that is not JSON, and the bounds it holds a stream to are all exercised.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// The PNG signature, then bytes that are not valid UTF-8: reading them as text
// and back would corrupt them, which is what a JSON-only client does.
var pngBytes = []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x80}

func TestGetCaptureReturnsTheBytesExactlyAsSentWithTheirMediaType(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.Path != "/v1/agent-sessions/agt_1/captures/cap_9" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer ds_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" {
			t.Errorf("Authorization=%q", got)
		}
		w.Header().Set("content-type", "image/png")
		_, _ = w.Write(pngBytes)
	})
	shot, err := client.AgentSessions.GetCapture(context.Background(), "agt_1", "cap_9")
	if err != nil {
		t.Fatal(err)
	}
	if shot.ContentType != "image/png" {
		t.Errorf("ContentType=%q", shot.ContentType)
	}
	if !bytes.Equal(shot.Bytes, pngBytes) {
		t.Errorf("Bytes=%v want %v", shot.Bytes, pngBytes)
	}
}

func TestGetCaptureSaysJPEGForAJPEGWithoutTheHeaderParameters(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "Image/JPEG; charset=binary")
		_, _ = w.Write(pngBytes)
	})
	shot, err := client.AgentSessions.GetCapture(context.Background(), "agt_1", "cap_9")
	if err != nil {
		t.Fatal(err)
	}
	if shot.ContentType != "image/jpeg" {
		t.Errorf("ContentType=%q", shot.ContentType)
	}
}

func TestGetCaptureEscapesBothIDs(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.EscapedPath(); got != "/v1/agent-sessions/agt%2F..%2Fx/captures/cap%201%2F2" {
			t.Errorf("path=%q", got)
		}
		w.Header().Set("content-type", "image/png")
		_, _ = w.Write(pngBytes)
	})
	if _, err := client.AgentSessions.GetCapture(context.Background(), "agt/../x", "cap 1/2"); err != nil {
		t.Fatal(err)
	}
}

func TestAScreenshotThatIsNoLongerKeptIsNotFoundNotAnEmptyImage(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/problem+json")
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(problemBody(404, "not-found", nil))
	})
	shot, err := client.AgentSessions.GetCapture(context.Background(), "agt_1", "cap_gone")
	var notFound *NotFoundError
	if !errors.As(err, &notFound) {
		t.Fatalf("err=%v, want *NotFoundError", err)
	}
	if shot != nil {
		t.Errorf("a missing screenshot returned %v", shot)
	}
}

func TestGetCaptureIsRetriedLikeAnyOtherGet(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	srv, _ := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.Header().Set("content-type", "application/problem+json")
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(problemBody(500, "internal", nil))
			return
		}
		w.Header().Set("content-type", "image/png")
		_, _ = w.Write(pngBytes)
	})
	client := New("ds_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", WithBaseURL(srv.URL),
		WithRetry(RetryConfig{MaxRetries: 2, InitialDelay: time.Millisecond, MaxDelay: 2 * time.Millisecond, BackoffMultiplier: 2}))
	shot, err := client.AgentSessions.GetCapture(context.Background(), "agt_1", "cap_9")
	if err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 || !bytes.Equal(shot.Bytes, pngBytes) {
		t.Errorf("calls=%d bytes=%v", calls.Load(), shot.Bytes)
	}
}

func TestGetCaptureRefusesABodyLargerThanTheResponseCeiling(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "image/png")
		chunk := bytes.Repeat([]byte{0xff}, 1024*1024)
		for i := 0; i < 9; i++ {
			_, _ = w.Write(chunk)
		}
	})
	_, err := client.AgentSessions.GetCapture(context.Background(), "agt_1", "cap_9")
	var transport *TransportError
	if !errors.As(err, &transport) || !strings.Contains(err.Error(), "exceeds 8388608-byte limit") {
		t.Fatalf("err=%v, want the response-ceiling TransportError", err)
	}
}

// ── the transcript ────────────────────────────────────────────────────────

func entryFrame(t *testing.T, index int, role, body string) string {
	t.Helper()
	data, err := json.Marshal(map[string]any{
		"index": index,
		"entry": map[string]any{"role": role, "body": body, "at": "2026-09-19T00:00:00Z"},
	})
	if err != nil {
		t.Fatal(err)
	}
	return "id: " + string(rune('0'+index)) + "\nevent: transcript.entry\ndata: " + string(data) + "\n\n"
}

func transcriptStream(t *testing.T) string {
	t.Helper()
	return ": stream open\n\n" +
		entryFrame(t, 0, "user", "Open the invoices page.") +
		entryFrame(t, 1, "agent", "navigate https://portal.example.test/invoices") +
		": heartbeat 2026-09-19T00:00:30.000Z\n\n" +
		"event: transcript.entry\ndata: {not json\n\n" +
		"event: something.new\ndata: {\"index\":7,\"entry\":{}}\n\n" +
		// An entry with no index is not one this SDK can place.
		"event: transcript.entry\ndata: {\"entry\":{\"role\":\"user\"}}\n\n" +
		entryFrame(t, 2, "user", "And the total?")
}

func TestTranscriptHandsOverEachEntryInOrderAndSkipsEverythingElse(t *testing.T) {
	t.Parallel()
	stream := transcriptStream(t)
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.Path != "/v1/agent-sessions/agt_1/transcript" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Accept"); got != "text/event-stream" {
			t.Errorf("Accept=%q", got)
		}
		if _, present := r.Header["Last-Event-Id"]; present {
			t.Error("a first read replays from the beginning: no Last-Event-ID")
		}
		// 17-byte pieces: every frame arrives split across several reads.
		writeInPieces(w, stream, 17)
	})
	var seen [][]string
	err := client.AgentSessions.Transcript(context.Background(), "agt_1", nil, func(e AgentTranscriptEvent) (bool, error) {
		seen = append(seen, []string{string(rune('0' + e.Index)), e.Entry.Role, e.Entry.Body})
		return true, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	want := [][]string{
		{"0", "user", "Open the invoices page."},
		{"1", "agent", "navigate https://portal.example.test/invoices"},
		{"2", "user", "And the total?"},
	}
	if !reflect.DeepEqual(seen, want) {
		t.Errorf("seen=%v\nwant %v", seen, want)
	}
}

func TestLastEventIDResumesAfterItIncludingZeroWhichIsAnIndexNotUnset(t *testing.T) {
	t.Parallel()
	var sent []string
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		sent = append(sent, r.Header.Get("Last-Event-ID"))
		w.Header().Set("content-type", "text/event-stream")
	})
	zero, later := 0, 41
	for _, id := range []*int{&zero, &later} {
		err := client.AgentSessions.Transcript(context.Background(), "agt_1", &TranscriptOptions{LastEventID: id},
			func(AgentTranscriptEvent) (bool, error) { return true, nil })
		if err != nil {
			t.Fatal(err)
		}
	}
	if !reflect.DeepEqual(sent, []string{"0", "41"}) {
		t.Errorf("Last-Event-ID sent=%v", sent)
	}
}

func TestReturningFalseStopsTheStreamAndClosesTheConnection(t *testing.T) {
	t.Parallel()
	gone := make(chan struct{})
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		_, _ = io.WriteString(w, entryFrame(t, 0, "user", "one")+entryFrame(t, 1, "agent", "two"))
		w.(http.Flusher).Flush()
		// The server keeps a transcript stream open: it only learns the reader
		// is gone when the connection closes.
		<-r.Context().Done()
		close(gone)
	})
	transcriptLength := 2
	var seen []int
	err := client.AgentSessions.Transcript(context.Background(), "agt_1", nil, func(e AgentTranscriptEvent) (bool, error) {
		seen = append(seen, e.Index)
		return e.Index < transcriptLength-1, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(seen, []int{0, 1}) {
		t.Errorf("seen=%v", seen)
	}
	select {
	case <-gone:
	case <-time.After(5 * time.Second):
		t.Fatal("the connection was still open 5s after the callback returned false")
	}
}

func TestAnErrorFromTheCallbackStopsTheStreamAndComesBackUnchanged(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		writeInPieces(w, entryFrame(t, 0, "user", "one")+entryFrame(t, 1, "agent", "two"), 64)
	})
	boom := errors.New("the caller could not store this entry")
	calls := 0
	err := client.AgentSessions.Transcript(context.Background(), "agt_1", nil, func(AgentTranscriptEvent) (bool, error) {
		calls++
		return true, boom
	})
	if !errors.Is(err, boom) || calls != 1 {
		t.Errorf("err=%v calls=%d", err, calls)
	}
}

func TestCancellingTheContextEndsTheStreamWithTheContextsError(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		_, _ = io.WriteString(w, entryFrame(t, 0, "user", "one"))
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	err := client.AgentSessions.Transcript(ctx, "agt_1", nil, func(AgentTranscriptEvent) (bool, error) {
		cancel()
		return true, nil
	})
	if !errors.Is(err, context.Canceled) {
		t.Errorf("err=%v, want context.Canceled", err)
	}
}

func TestTheStreamIsHeldToAnAbsoluteTimeLimit(t *testing.T) {
	t.Parallel()
	// Fifty minutes by default, the same backstop a message has.
	if AgentMessageStreamTimeout != 50*time.Minute {
		t.Fatalf("AgentMessageStreamTimeout=%v", AgentMessageStreamTimeout)
	}
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		_, _ = io.WriteString(w, entryFrame(t, 0, "user", "one"))
		w.(http.Flusher).Flush()
		<-r.Context().Done() // keeps the stream open past the limit
	})
	var seen []int
	started := time.Now()
	err := client.AgentSessions.Transcript(context.Background(), "agt_1", &TranscriptOptions{Timeout: 50 * time.Millisecond},
		func(e AgentTranscriptEvent) (bool, error) {
			seen = append(seen, e.Index)
			return true, nil
		})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("err=%v, want context.DeadlineExceeded", err)
	}
	if !reflect.DeepEqual(seen, []int{0}) {
		t.Errorf("seen=%v", seen)
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Errorf("the limit took %v to bite", elapsed)
	}
}

func TestTheWholeStreamIsHeldToTheResponseCeiling(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		filler := ": " + strings.Repeat("x", 1024*1024) + "\n\n"
		for i := 0; i < 9; i++ {
			_, _ = io.WriteString(w, filler)
		}
	})
	err := client.AgentSessions.Transcript(context.Background(), "agt_1", nil,
		func(AgentTranscriptEvent) (bool, error) { return true, nil })
	var transport *TransportError
	if !errors.As(err, &transport) || !strings.Contains(err.Error(), "exceeds 8388608-byte limit") {
		t.Fatalf("err=%v, want the response-ceiling TransportError", err)
	}
}

func TestTheEleventhOpenStreamIsARateLimitErrorSentOnce(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("content-type", "application/problem+json")
		w.Header().Set("Retry-After", "30")
		w.WriteHeader(http.StatusTooManyRequests)
		_ = json.NewEncoder(w).Encode(problemBody(429, "rate-limited", map[string]any{"retry_after_seconds": 30}))
	})
	err := client.AgentSessions.Transcript(context.Background(), "agt_1", nil,
		func(AgentTranscriptEvent) (bool, error) { return true, nil })
	var limited *RateLimitError
	if !errors.As(err, &limited) {
		t.Fatalf("err=%v, want *RateLimitError", err)
	}
	if limited.RetryAfterSeconds != 30 {
		t.Errorf("RetryAfterSeconds=%d", limited.RetryAfterSeconds)
	}
	// Never retried: the caller knows where to resume from.
	if calls.Load() != 1 {
		t.Errorf("requests=%d, want 1", calls.Load())
	}
}

func TestA200ThatIsNotAnEventStreamIsAContractErrorNotAnEmptyTranscript(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = io.WriteString(w, "{}")
	})
	err := client.AgentSessions.Transcript(context.Background(), "agt_1", nil,
		func(AgentTranscriptEvent) (bool, error) { return true, nil })
	var transport *TransportError
	if !errors.As(err, &transport) || !strings.Contains(err.Error(), "expected an event stream") {
		t.Fatalf("err=%v, want the not-an-event-stream TransportError", err)
	}
}
