// The list of clips the personas need and the manifest that says which text and voice each mp3 was rendered from.
// Used by scripts/render-clips.ts (renders what is stale) and by the tests (a persona line whose text changed after its
// clip was rendered is a failing test, so the voice never says something the data does not say). Node only: it hashes.
import { createHash } from 'node:crypto';
import { PERSONAS, PERSONA_IDS_IN_ORDER, clipIdOf } from './personas.ts';
import type { PersonaId } from './personas.ts';

/** What the clips are rendered with. Part of the hash: a change here re-renders everything. */
export const TTS_SETTINGS = {
  model: 'eleven_flash_v2_5',
  outputFormat: 'mp3_44100_64',
  voiceSettings: { stability: 0.5, similarity_boost: 0.75, speed: 1.0 },
} as const;

export interface PlannedClip {
  clipId: string;
  persona: PersonaId;
  lineId: string;
  /** Path of the mp3 relative to the sim directory. */
  file: string;
  text: string;
  voiceId: string;
  voiceName: string;
  /** sha256 of everything that decides what the clip sounds like. */
  hash: string;
}

export interface ManifestClip {
  file: string;
  persona: PersonaId;
  lineId: string;
  text: string;
  voiceId: string;
  voiceName: string;
  model: string;
  outputFormat: string;
  /** sha256 of text, voice and settings the clip was rendered from. */
  textHash: string;
  bytes: number;
  /** Estimated from the constant bitrate (64 kbit/s); the browser measures the real length when it decodes the clip. */
  approxDurationMs: number;
}

export interface ClipManifest {
  schemaVersion: 1;
  note: string;
  clips: Record<string, ManifestClip>;
}

export const MANIFEST_FILE = 'clips/manifest.json';
export const MANIFEST_NOTE =
  'Synthetic voice clips for the simulated expert and new hire, rendered by scripts/render-clips.ts with ElevenLabs text-to-speech. ' +
  'Nothing here is a real person or a recording of one.';

export function clipHash(text: string, voiceId: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        text,
        voiceId,
        model: TTS_SETTINGS.model,
        outputFormat: TTS_SETTINGS.outputFormat,
        voiceSettings: TTS_SETTINGS.voiceSettings,
      }),
    )
    .digest('hex');
}

/** Every line of every persona, with its clip id, file and hash. */
export function planClips(only?: PersonaId): PlannedClip[] {
  const out: PlannedClip[] = [];
  for (const id of PERSONA_IDS_IN_ORDER) {
    if (only && id !== only) continue;
    const persona = PERSONAS[id];
    for (const l of persona.lines) {
      out.push({
        clipId: clipIdOf(id, l.id),
        persona: id,
        lineId: l.id,
        file: `clips/${id}/${l.id}.mp3`,
        text: l.text,
        voiceId: persona.voice.voiceId,
        voiceName: persona.voice.voiceName,
        hash: clipHash(l.text, persona.voice.voiceId),
      });
    }
  }
  return out;
}

/** Bytes to milliseconds at the constant bitrate of mp3_44100_64. */
export const approxDurationMs = (bytes: number): number => Math.round((bytes * 8) / 64);

/** Clips whose manifest entry is missing, was rendered from other text or voice, or whose file is missing. */
export function staleClips(
  planned: readonly PlannedClip[],
  manifest: ClipManifest | null,
  fileExists: (file: string) => boolean,
): PlannedClip[] {
  return planned.filter((p) => {
    const m = manifest?.clips[p.clipId];
    return m === undefined || m.textHash !== p.hash || m.file !== p.file || !fileExists(p.file);
  });
}
