/**
 * The bundled font for all in-canvas text.
 *
 * **Why this file exists.** drei's `<Text>` is troika-three-text, and when no
 * `font` prop is given troika resolves fonts at *runtime* from a CDN:
 *
 *   https://cdn.jsdelivr.net/gh/lojjic/unicode-font-resolver@v1.0.1/...
 *
 * That makes the unit-cell axis labels and the energy readout — the element
 * carrying the NEB migration-path shot — dependent on the network. Offline, or
 * behind a blocked CDN, they silently fail to render. So every `<Text>` in this
 * directory passes `font={STRUCTURE_FONT_URL}`.
 *
 * **Coverage matters, not just the prop.** troika only falls back to the CDN
 * for codepoints the supplied font does not cover, so a Latin-only font would
 * still reach for the network on a single `Δ`. This build of Noto Sans covers
 * Latin, Greek, Cyrillic and General Punctuation, which keeps `Δ`, `Å`, `−`,
 * `—` and `…` local, and makes an arbitrary caption passed in by the app shell
 * safe too.
 *
 * **Format matters.** troika bundles a WOFF1→OTF converter but explicitly
 * throws on WOFF2 ("woff2 fonts not supported"), so this must stay a .ttf —
 * do not "optimize" it to .woff2. The `next/font` woff2 files already in the
 * tree cannot be used for this.
 *
 * Noto Sans, SIL Open Font License 1.1 — see `fonts/OFL.txt`.
 *
 * The file is ~540 KB because it is the full unsubsetted face. It is a static,
 * cached, build-time asset, so this costs one request; if that ever matters it
 * can be subset to the Latin + Greek ranges with `fonttools pyftsubset`.
 */

/**
 * Resolved by the bundler at build time (webpack 5 / Turbopack both rewrite
 * `new URL(..., import.meta.url)` into an emitted asset URL), so the font is
 * served from this app's own origin rather than fetched from anywhere else.
 */
export const STRUCTURE_FONT_URL: string = new URL(
  "./fonts/NotoSans-Regular.ttf",
  import.meta.url,
).href;

/**
 * Characters to pre-rasterize into the SDF atlas on first load, so the first
 * rendered frame already has glyphs instead of popping in a moment later.
 * Covers every character these components can produce on their own.
 */
export const STRUCTURE_FONT_CHARACTERS =
  "abcdefghijklmnopqrstuvwxyz" +
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ" +
  "0123456789" +
  " .,:;!?'\"()[]{}<>/\\|-+=*%#&@^~`$_" +
  "Δ" + // delta, for dE
  "ÅÅ" + // angstrom
  "−–—…·°"; // minus, dashes, ellipsis, middot, degree

/** Props every `<Text>` in this directory spreads, so none can forget. */
export const TEXT_FONT_PROPS = {
  font: STRUCTURE_FONT_URL,
  characters: STRUCTURE_FONT_CHARACTERS,
} as const;
