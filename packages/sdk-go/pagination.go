package driftstack

// advanceCursor validates the next cursor a list endpoint returned against the
// cursor that was just sent. It is the shared termination + safety logic for
// every resource's Iterate helper.
//
//   - next is nil or "" → (_, true, nil): last page, stop the walk.
//   - *next == current → (_, false, error): the server did NOT advance the
//     cursor. Keyset pagination always returns a strictly-new next_cursor, so a
//     repeated cursor means a buggy server / proxy / cache. Without this guard
//     the Iterate loop would spin forever and silently hang the caller — the
//     worst failure mode. Return a TransportError instead (mirrors the TS +
//     Python SDK auto-paginator guards).
//   - otherwise → (*next, false, nil): advance to the new cursor.
func advanceCursor(current string, next *string) (string, bool, error) {
	if next == nil || *next == "" {
		return "", true, nil
	}
	if *next == current {
		return "", false, &TransportError{apiError: apiError{
			Status:  0,
			Message: "pagination did not advance: the server returned the same cursor twice",
		}}
	}
	return *next, false, nil
}
