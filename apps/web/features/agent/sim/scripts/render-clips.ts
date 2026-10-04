// Renders the personas' spoken lines to mp3 with ElevenLabs text-to-speech (REST: POST /v1/text-to-speech/{voice_id}).
//
//   ELEVENLABS_API_KEY=... node apps/web/features/agent/sim/scripts/render-clips.ts          renders the clips that are stale
//   node .../render-clips.ts --force                                                          renders everything again
//   node .../render-clips.ts --only expert                                                    one persona
//   node .../render-clips.ts --check                                                          no network: lists stale clips, exits 1 if any
//
// The key is read from the environment only. It is never printed, logged or written to a file (the manifest records the
// voice id, the model, the output format and a hash of the text, nothing else). Behind a proxy that Node's fetch does not
// pick up by itself, run with NODE_USE_ENV_PROXY=1 (and NODE_EXTRA_CA_CERTS=<bundle> if the proxy re-signs TLS).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST_FILE, MANIFEST_NOTE, TTS_SETTINGS, approxDurationMs, planClips, staleClips } from '../clip-plan.ts';
import type { ClipManifest, ManifestClip, PlannedClip } from '../clip-plan.ts';
import { PERSONA_IDS_IN_ORDER } from '../personas.ts';
import type { PersonaId } from '../personas.ts';

const SIM_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINT = 'https://api.elevenlabs.io/v1/text-to-speech';
/** A clip is a few seconds long; anything bigger than this is not a clip. */
const MAX_CLIP_BYTES = 400_000;

function readManifest(): ClipManifest | null {
  const path = join(SIM_DIR, MANIFEST_FILE);
  if (!existsSync(path)) return null;
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('clips' in parsed)) throw new Error(`${MANIFEST_FILE} is not a manifest`);
  return parsed as ClipManifest;
}

function writeManifest(manifest: ClipManifest): void {
  const sorted: Record<string, ManifestClip> = {};
  for (const key of Object.keys(manifest.clips).sort()) {
    const clip = manifest.clips[key];
    if (clip) sorted[key] = clip;
  }
  writeFileSync(join(SIM_DIR, MANIFEST_FILE), `${JSON.stringify({ ...manifest, clips: sorted }, null, 2)}\n`);
}

async function render(apiKey: string, clip: PlannedClip): Promise<Uint8Array> {
  const url = `${ENDPOINT}/${encodeURIComponent(clip.voiceId)}?output_format=${TTS_SETTINGS.outputFormat}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'xi-api-key': apiKey, accept: 'audio/mpeg' },
    body: JSON.stringify({ text: clip.text, model_id: TTS_SETTINGS.model, voice_settings: TTS_SETTINGS.voiceSettings }),
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    throw new Error(`text-to-speech failed for ${clip.clipId}: HTTP ${response.status} ${body}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_CLIP_BYTES) throw new Error(`text-to-speech returned ${bytes.length} bytes for ${clip.clipId}`);
  return bytes;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const check = args.includes('--check');
  const onlyIndex = args.indexOf('--only');
  const onlyValue = onlyIndex >= 0 ? args[onlyIndex + 1] : undefined;
  const only = PERSONA_IDS_IN_ORDER.find((id): id is PersonaId => id === onlyValue);
  if (onlyIndex >= 0 && only === undefined) throw new Error(`--only takes one of: ${PERSONA_IDS_IN_ORDER.join(', ')}`);

  const planned = planClips(only);
  const existing = readManifest();
  const stale = force ? planned : staleClips(planned, existing, (file) => existsSync(join(SIM_DIR, file)));
  console.log(`${planned.length} clips planned, ${stale.length} to render`);
  if (check) {
    for (const clip of stale) console.log(`  stale: ${clip.clipId}`);
    process.exitCode = stale.length > 0 ? 1 : 0;
    return;
  }
  if (stale.length === 0) return;

  const apiKey = process.env['ELEVENLABS_API_KEY'];
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not set in the environment');

  const manifest: ClipManifest = existing ?? { schemaVersion: 1, note: MANIFEST_NOTE, clips: {} };
  manifest.note = MANIFEST_NOTE;
  for (const clip of stale) {
    const bytes = await render(apiKey, clip);
    const path = join(SIM_DIR, clip.file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    manifest.clips[clip.clipId] = {
      file: clip.file,
      persona: clip.persona,
      lineId: clip.lineId,
      text: clip.text,
      voiceId: clip.voiceId,
      voiceName: clip.voiceName,
      model: TTS_SETTINGS.model,
      outputFormat: TTS_SETTINGS.outputFormat,
      textHash: clip.hash,
      bytes: bytes.length,
      approxDurationMs: approxDurationMs(bytes.length),
    };
    // Written after every clip: an interrupted run keeps what it has rendered.
    writeManifest(manifest);
    console.log(`  rendered ${clip.clipId} (${bytes.length} bytes, about ${approxDurationMs(bytes.length)} ms)`);
  }
  // Clips of lines that no longer exist are dropped from the manifest (their files are removed by hand or by git).
  const live = new Set(planClips().map((c) => c.clipId));
  for (const id of Object.keys(manifest.clips)) if (!live.has(id)) delete manifest.clips[id];
  writeManifest(manifest);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
