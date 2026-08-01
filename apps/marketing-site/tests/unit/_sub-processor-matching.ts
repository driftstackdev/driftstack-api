// Shared matcher for the SUB_PROCESSORS ↔ legal-document parity guards.
//
// Two guards use it — privacy.md (W284.A) and the DPA Annex 3 table (W283.A) —
// and each also uses it to prove the matcher still detects a missing entry.
// That is the point of putting it here: a reachability check that re-implemented
// the matching would prove its own copy works, which is not the question being
// asked of it.

/**
 * Is `name` named in `doc`?
 *
 * The legal documents may use the longer legal-entity name — "Hetzner Online
 * GmbH" for "Hetzner Cloud" — so the leading vendor word is accepted as a
 * fallback, that word being invariant across the short and legal forms. As of
 * this writing exactly one of the twelve entries relies on that fallback, which
 * is the case the comment describes; the other eleven match in full.
 */
export function namedIn(doc: string, name: string): boolean {
  if (doc.includes(name)) return true;
  const leadingWord = name.split(/\s+/)[0]!;
  return new RegExp(`\\b${leadingWord}\\b`).test(doc);
}

/**
 * Entries of `names` that the document fails to name.
 *
 * A GDPR Art. 28 disclosure is the thing being guarded, so the failure that
 * matters is a sub-processor we actually use going unnamed — which is why the
 * callers assert a floor on the roster before asserting this is empty. An empty
 * roster makes "nothing is missing" true and meaningless.
 */
export function unnamedIn(doc: string, names: readonly string[]): string[] {
  return names.filter((n) => !namedIn(doc, n));
}
