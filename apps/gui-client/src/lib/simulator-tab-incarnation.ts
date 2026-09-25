// The tab-incarnation fence for page-state frames from the phone.
//
// A tab's renderer can be replaced on the phone (a warm tab rolled back, a
// crashed renderer restarted) while the tab keeps its id. Frames the OLD
// renderer already queued can still arrive, and membership in the tab set
// cannot tell them from the new renderer's. The phone stamps each frame with
// `tabIncarnation`: omitted while a tab has never been replaced (incarnation
// 0), then 1, 2, … — monotonic per tab. So the rule is: for each tab, the
// highest incarnation seen is current, and a frame with a lower one (an absent
// stamp reads as 0) came from a renderer that is gone — inert.
//
// Only frames that NAME a tab are fenced, and only on the live channel: an
// untagged frame is a legacy node's (membership already routes it to the
// active tab), and the server's stored copy does not carry the stamp at all,
// so there absence is "unknown", not "0".

/** The highest incarnation seen, per tab id. */
export type TabIncarnations = Map<string, number>;

/**
 * Admit a live frame for `tabId`, recording a newer incarnation. Returns false
 * for a frame from a replaced renderer.
 */
export function admitTabIncarnation(
  seen: TabIncarnations,
  tabId: string,
  rawIncarnation: unknown,
): boolean {
  const incarnation =
    typeof rawIncarnation === 'number' && Number.isInteger(rawIncarnation) && rawIncarnation >= 0
      ? rawIncarnation
      : rawIncarnation === undefined || rawIncarnation === null
        ? 0
        : null;
  // A malformed stamp is not evidence either way: let membership decide.
  if (incarnation === null) return true;
  const current = seen.get(tabId) ?? 0;
  if (incarnation < current) return false;
  if (incarnation > current) seen.set(tabId, incarnation);
  return true;
}
