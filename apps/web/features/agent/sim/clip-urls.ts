// Where the clips are served from. Browser only (Vite): the mp3 files live next to this module under clips/ and Vite turns
// each into a URL, in dev and in the build. Kept apart from index.ts because `import.meta.glob` does not exist in Node.
const URLS = import.meta.glob<string>('./clips/*/*.mp3', { query: '?url', import: 'default', eager: true });

/** The URL of a clip (`expert.reason`), or null when there is no such clip. */
export function clipUrl(clipId: string): string | null {
  const dot = clipId.indexOf('.');
  if (dot <= 0) return null;
  const persona = clipId.slice(0, dot);
  const line = clipId.slice(dot + 1);
  return URLS[`./clips/${persona}/${line}.mp3`] ?? null;
}

/** Every clip id the build holds. */
export function allClipIds(): string[] {
  return Object.keys(URLS)
    .map((path) => /^\.\/clips\/([^/]+)\/([^/]+)\.mp3$/.exec(path))
    .flatMap((m) => (m?.[1] && m[2] ? [`${m[1]}.${m[2]}`] : []))
    .sort();
}

/** The bytes of a clip, for createSyntheticMic({ loadClip }). */
export async function fetchClip(clipId: string): Promise<ArrayBuffer> {
  const url = clipUrl(clipId);
  if (url === null) throw new Error(`there is no voice clip "${clipId}"`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`the clip ${clipId} could not be fetched (HTTP ${response.status})`);
  return response.arrayBuffer();
}
