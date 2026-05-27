package driftstack

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

func TestCryptoOrders_Quote(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/billing/crypto-checkout/quote" || r.Method != "POST" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"price_cents":999,"asset":"usdc"}`))
	})
	got, err := client.CryptoOrders.Quote(context.Background(), map[string]any{
		"product": "solo_manual",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got["price_cents"].(float64) != 999 {
		t.Errorf("price_cents=%v", got["price_cents"])
	}
}

func TestCryptoOrders_CreateCheckout_ForwardsIdempotencyKey(t *testing.T) {
	t.Parallel()
	var sawKey string
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		sawKey = r.Header.Get("Idempotency-Key")
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"order_id":"ord_1"}`))
	})
	key := "abc-123"
	_, err := client.CryptoOrders.CreateCheckout(
		context.Background(),
		map[string]any{"product": "solo_manual"},
		&CreateCheckoutOptions{IdempotencyKey: &key},
	)
	if err != nil {
		t.Fatal(err)
	}
	if sawKey != "abc-123" {
		t.Errorf("Idempotency-Key header = %q, want %q", sawKey, "abc-123")
	}
}

func TestCryptoOrders_CreateCheckout_PreservesAuthHeader(t *testing.T) {
	// The headers map in requestOptions is merged AFTER Authorization /
	// User-Agent / Content-Type are set; a future refactor mustn't let
	// caller-supplied headers (e.g. Idempotency-Key) clobber the
	// bearer token by accident.
	t.Parallel()
	var sawAuth, sawKey, sawUA string
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		sawAuth = r.Header.Get("Authorization")
		sawKey = r.Header.Get("Idempotency-Key")
		sawUA = r.Header.Get("User-Agent")
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	})
	key := "k-1"
	if _, err := client.CryptoOrders.CreateCheckout(
		context.Background(),
		map[string]any{"product": "solo_manual"},
		&CreateCheckoutOptions{IdempotencyKey: &key},
	); err != nil {
		t.Fatal(err)
	}
	if sawAuth != "Bearer ds_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" {
		t.Errorf("Authorization header = %q, want Bearer …", sawAuth)
	}
	if sawKey != "k-1" {
		t.Errorf("Idempotency-Key = %q", sawKey)
	}
	if sawUA == "" {
		t.Errorf("User-Agent missing")
	}
}

func TestCryptoOrders_CreateCheckout_NoKeyOmitsHeader(t *testing.T) {
	t.Parallel()
	var sawKey string
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		sawKey = r.Header.Get("Idempotency-Key")
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"order_id":"ord_1"}`))
	})
	if _, err := client.CryptoOrders.CreateCheckout(
		context.Background(),
		map[string]any{"product": "solo_manual"},
		nil,
	); err != nil {
		t.Fatal(err)
	}
	if sawKey != "" {
		t.Errorf("expected no Idempotency-Key header, got %q", sawKey)
	}
}

func TestCryptoOrders_List_PassesThroughFilters(t *testing.T) {
	t.Parallel()
	var sawQuery string
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		sawQuery = r.URL.RawQuery
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"orders":[],"next_cursor":null}`))
	})
	lim := 25
	status := "paid"
	cur := "c0"
	after := "2026-05-01T00:00:00Z"
	before := "2026-06-01T00:00:00Z"
	_, err := client.CryptoOrders.List(context.Background(), &ListCryptoOrdersOptions{
		Limit:         &lim,
		Status:        &status,
		Cursor:        &cur,
		CreatedAfter:  &after,
		CreatedBefore: &before,
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"limit=25",
		"status=paid",
		"cursor=c0",
		"created_after=2026-05-01T00%3A00%3A00Z",
		"created_before=2026-06-01T00%3A00%3A00Z",
	}
	for _, w := range want {
		if !contains(sawQuery, w) {
			t.Errorf("query %q missing %q", sawQuery, w)
		}
	}
}

func TestCryptoOrders_List_OmitsUnsetParams(t *testing.T) {
	t.Parallel()
	var sawQuery string
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		sawQuery = r.URL.RawQuery
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"orders":[]}`))
	})
	if _, err := client.CryptoOrders.List(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if sawQuery != "" {
		t.Errorf("expected no query string, got %q", sawQuery)
	}
}

func TestCryptoOrders_Iterate_WalksCursorPages(t *testing.T) {
	t.Parallel()
	c1 := "c1"
	c2 := "c2"
	pages := []ListCryptoOrdersResponse{
		{Orders: []CryptoOrderEnvelope{{"id": "ord_1"}}, NextCursor: &c1},
		{Orders: []CryptoOrderEnvelope{{"id": "ord_2"}, {"id": "ord_3"}}, NextCursor: &c2},
		{Orders: []CryptoOrderEnvelope{{"id": "ord_4"}}, NextCursor: nil},
	}
	seenCursors := []string{}
	idx := 0
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		seenCursors = append(seenCursors, r.URL.Query().Get("cursor"))
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(pages[idx])
		idx++
	})
	var ids []string
	err := client.CryptoOrders.Iterate(context.Background(), nil, func(o CryptoOrderEnvelope) bool {
		ids = append(ids, o["id"].(string))
		return true
	})
	if err != nil {
		t.Fatal(err)
	}
	wantIDs := []string{"ord_1", "ord_2", "ord_3", "ord_4"}
	if len(ids) != len(wantIDs) {
		t.Fatalf("ids=%v, want=%v", ids, wantIDs)
	}
	for i, id := range ids {
		if id != wantIDs[i] {
			t.Errorf("ids[%d]=%q, want %q", i, id, wantIDs[i])
		}
	}
	wantCursors := []string{"", "c1", "c2"}
	if len(seenCursors) != len(wantCursors) {
		t.Fatalf("cursors=%v, want=%v", seenCursors, wantCursors)
	}
	for i, c := range seenCursors {
		if c != wantCursors[i] {
			t.Errorf("cursors[%d]=%q, want %q", i, c, wantCursors[i])
		}
	}
}

func TestCryptoOrders_Iterate_TreatsEmptyCursorAsTerminal(t *testing.T) {
	t.Parallel()
	empty := ""
	pages := []ListCryptoOrdersResponse{
		{Orders: []CryptoOrderEnvelope{{"id": "ord_1"}}, NextCursor: &empty},
	}
	idx := 0
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(pages[idx])
		idx++
	})
	var ids []string
	err := client.CryptoOrders.Iterate(context.Background(), nil, func(o CryptoOrderEnvelope) bool {
		ids = append(ids, o["id"].(string))
		return true
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 1 || ids[0] != "ord_1" {
		t.Errorf("ids=%v, want [ord_1]", ids)
	}
	// An empty-string next_cursor must be treated as terminal (matching the
	// audit-log / profiles / profile-snapshots iterators). Otherwise the loop
	// would re-fetch with cursor="" and over-run the single-page slice.
	if idx != 1 {
		t.Errorf("fetched %d pages, want 1 (empty cursor should be terminal)", idx)
	}
}

func TestCryptoOrders_Iterate_StopsEarlyOnVisitFalse(t *testing.T) {
	t.Parallel()
	c1 := "c1"
	pages := []ListCryptoOrdersResponse{
		{Orders: []CryptoOrderEnvelope{{"id": "ord_1"}, {"id": "ord_2"}}, NextCursor: &c1},
		// Should not be fetched — visit returns false on ord_1.
		{Orders: []CryptoOrderEnvelope{{"id": "ord_3"}}, NextCursor: nil},
	}
	idx := 0
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(pages[idx])
		idx++
	})
	var ids []string
	err := client.CryptoOrders.Iterate(context.Background(), nil, func(o CryptoOrderEnvelope) bool {
		ids = append(ids, o["id"].(string))
		// Stop after the first order.
		return false
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 1 || ids[0] != "ord_1" {
		t.Errorf("ids=%v, want [ord_1]", ids)
	}
	if idx != 1 {
		t.Errorf("fetched %d pages, want 1", idx)
	}
}

func TestCryptoOrders_Get_EncodesOrderID(t *testing.T) {
	t.Parallel()
	var sawPath string
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		// RequestURI preserves percent-encoding; Path is decoded.
		sawPath = r.RequestURI
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"id":"co/with/slash"}`))
	})
	if _, err := client.CryptoOrders.Get(context.Background(), "co/with/slash"); err != nil {
		t.Fatal(err)
	}
	// url.PathEscape encodes '/' to %2F.
	if sawPath != "/v1/billing/crypto-orders/co%2Fwith%2Fslash" {
		t.Errorf("path=%q, want encoded slashes", sawPath)
	}
}

func TestCryptoOrders_Receipt_Path(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/billing/crypto-orders/ord_1/receipt" {
			t.Errorf("path=%q", r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"order_id":"ord_1"}`))
	})
	out, err := client.CryptoOrders.Receipt(context.Background(), "ord_1")
	if err != nil {
		t.Fatal(err)
	}
	if out["order_id"] != "ord_1" {
		t.Errorf("order_id=%v", out["order_id"])
	}
}

func TestCryptoOrders_Cancel_Path(t *testing.T) {
	t.Parallel()
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/billing/crypto-orders/ord_1/cancel" || r.Method != "POST" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"id":"ord_1","status":"cancelled"}`))
	})
	out, err := client.CryptoOrders.Cancel(context.Background(), "ord_1")
	if err != nil {
		t.Fatal(err)
	}
	if out["status"] != "cancelled" {
		t.Errorf("status=%v", out["status"])
	}
}

func TestCryptoOrders_UpdateNote_PATCH(t *testing.T) {
	t.Parallel()
	var sawBody map[string]any
	_, client := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "PATCH" {
			t.Errorf("method=%q, want PATCH", r.Method)
		}
		_ = json.NewDecoder(r.Body).Decode(&sawBody)
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"id":"ord_1","customer_note":"PO-1"}`))
	})
	if _, err := client.CryptoOrders.UpdateNote(
		context.Background(),
		"ord_1",
		map[string]any{"customer_note": "PO-1"},
	); err != nil {
		t.Fatal(err)
	}
	if sawBody["customer_note"] != "PO-1" {
		t.Errorf("body=%v", sawBody)
	}
}

// helper — `strings.Contains` would do, but pulling the import in just
// for tests bloats the file. Keep this tiny local one to match the
// pattern in client_test.go.
func contains(haystack, needle string) bool {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
