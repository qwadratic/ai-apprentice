// The Clipa logo: the teal paperclip mark (the same wire as the <clipa-buddy> character, with the arm down and dot eyes)
// and the word Clipa. The mark is also the page's favicon.

// SVG user units, viewBox "12 4 96 120": the buddy's body wire, continued down the left leg where its arm hangs.
const WIRE = 'M66 84V98A12 12 0 0 0 90 98V48A30 30 0 0 0 30 48V102';
const TEAL = '#17b3a3';
const TEAL_DARK = '#0b5d56';
const HIGHLIGHT = '#a3f2e7';
const PLATE = '#f1fbf9';
const INK = '#0f2d2a';

/** The mark as an SVG string, for the favicon. */
export const CLIPA_MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="12 4 96 120"><circle cx="60" cy="48" r="25" fill="${PLATE}"/><g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="${WIRE}" stroke="${TEAL_DARK}" stroke-width="15.6"/><path d="${WIRE}" stroke="${TEAL}" stroke-width="12"/><path d="${WIRE}" stroke="${HIGHLIGHT}" stroke-width="2.8" transform="translate(-2.2 -2.2)"/></g><circle cx="51" cy="46" r="4.3" fill="${INK}"/><circle cx="69" cy="46" r="4.3" fill="${INK}"/></svg>`;

export function ClipaMark({ size = 30 }: { size?: number }) {
  return (
    <svg className="as-logo__mark" width={Math.round(size * 0.8)} height={size} viewBox="12 4 96 120" aria-hidden="true" focusable="false">
      <circle cx="60" cy="48" r="25" fill={PLATE} />
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d={WIRE} stroke={TEAL_DARK} strokeWidth="15.6" />
        <path d={WIRE} stroke={TEAL} strokeWidth="12" />
        <path d={WIRE} stroke={HIGHLIGHT} strokeWidth="2.8" transform="translate(-2.2 -2.2)" />
      </g>
      <circle cx="51" cy="46" r="4.3" fill={INK} />
      <circle cx="69" cy="46" r="4.3" fill={INK} />
    </svg>
  );
}

export function ClipaLogo() {
  return (
    <span className="as-logo" role="img" aria-label="Clipa">
      <ClipaMark />
      <span className="as-logo__word" aria-hidden="true">Clipa</span>
    </span>
  );
}

/** Points the page's favicon at the mark (the scaffold's index.html has none). */
export function setClipaFavicon(): void {
  if (typeof document === 'undefined') return;
  const href = `data:image/svg+xml,${encodeURIComponent(CLIPA_MARK_SVG)}`;
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.type = 'image/svg+xml';
  link.href = href;
}
