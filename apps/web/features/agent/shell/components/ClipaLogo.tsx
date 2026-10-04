// The Clipa logo: the word "clipa" in italic script, bent from the same teal wire as the <clipa-buddy> character, but
// with no face, so the logo is never mistaken for Clipa herself on the page. The wire "c" alone is the favicon.

const OUTLINE = '#0b5d56';
const BODY = '#17b3a3';
const SHADE = '#0f9585';
const HIGHLIGHT = '#a3f2e7';

// Wire pieces on a 96 x 66 grid, written upright and slanted by the transform below.
const C = 'M21 30C19 25 9 25 8 34C7 43 17 46 23 40';
const WORD = [
  // c, l with its loop, i, and the stem of p: one wire
  `${C}C28 35 34 22 34 13C34 6 28 6 28 13C28 24 28 36 30 42C31 45 35 45 37 41C38 38 39 32 40 27C40 33 39 39 41 43C42 45 45 45 47 42C48 39 49 32 50 27L47.5 60`,
  // the bowl of p
  'M49.6 31C52 25 61 24 61 33C61 42 53 45 49.3 40',
  // a: bowl, stem and tail
  'M76 27C72 23 63 25 63 34C63 42 72 44 75.6 34L76.4 26L75 41C74.6 44 78 45 81 41',
  // the dot of the i
  'M41.6 19.5L41.7 19.4',
];

/** Outline, body, shade and highlight, stacked like the character's wire. */
function wireSvg(pieces: readonly string[]): string {
  const layer = (color: string, width: number, dx: number, dy: number): string =>
    `<g transform="translate(${dx} ${dy})" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${pieces.map((d) => `<path d="${d}"/>`).join('')}</g>`;
  return `${layer(OUTLINE, 6.8, 0, 0)}${layer(BODY, 5.2, 0, 0)}${layer(SHADE, 2.2, 0.7, 0.8)}${layer(HIGHLIGHT, 1.3, -1, -1)}`;
}

const WORDMARK_INNER = `<g transform="translate(14 0) skewX(-14)">${wireSvg(WORD)}</g>`;

/** The wire "c" on a pale tile, as an SVG string for the favicon. */
export const CLIPA_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#e6f7f4"/><g transform="translate(9.8 -19.5) skewX(-14)">${wireSvg([C])}</g></svg>`;

/** The wordmark. `height` is its size in px; the header shows it at 64 (smaller on phones through shell.css). */
export function ClipaLogo({ height = 64 }: { height?: number }) {
  return (
    <span
      className="as-logo"
      role="img"
      aria-label="Clipa"
      // Static, trusted markup built from the constants above (no user data).
      dangerouslySetInnerHTML={{ __html: `<svg class="as-logo__word" width="${Math.round(height * 96 / 66)}" height="${height}" viewBox="0 0 96 66" aria-hidden="true" focusable="false">${WORDMARK_INNER}</svg>` }}
    />
  );
}

/** Points the page's favicon at the wire "c" (the scaffold's index.html has none). */
export function setClipaFavicon(): void {
  if (typeof document === 'undefined') return;
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.type = 'image/svg+xml';
  link.href = `data:image/svg+xml,${encodeURIComponent(CLIPA_FAVICON_SVG)}`;
}
