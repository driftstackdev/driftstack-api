// Shared Unicode extended-grapheme segmentation for keyboard-shaped outputs.
// A user-perceived key such as 👩‍💻, é, or 🇺🇸 spans multiple UTF-16 code
// units. Splitting those units creates lone-surrogate/ZWJ/combining-mark events
// that no real keyboard emits.

const GRAPHEME_SEGMENTER = new Intl.Segmenter('und', { granularity: 'grapheme' });

/** Split text into deterministic user-perceived Unicode characters. */
export function splitGraphemes(text: string): string[] {
  return Array.from(GRAPHEME_SEGMENTER.segment(text), ({ segment }) => segment);
}
