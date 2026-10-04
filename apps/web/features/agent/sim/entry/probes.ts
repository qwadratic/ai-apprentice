// Two probes for the simulation's own page. They consume the shimmed devices the way the product does, so a run can show
// that the persona's voice really reaches a reader of getUserMedia and that getDisplayMedia really returns this tab.
//   - Ears: reads a microphone stream through an analyser and counts how long it carried speech (not silence).
//   - Capture: reads the shared screen into a video element and checks that the frames are not blank.
import type { Clock } from '../clock.ts';

export interface EarsReport {
  /** Total time the stream carried a signal above the silence threshold. */
  speechMs: number;
  /** How many separate stretches of speech (split by at least `gapMs` of silence). */
  utterances: number;
  /** The loudest level seen, 0..1 (RMS). */
  peak: number;
}

export interface Ears {
  report(): EarsReport;
  stop(): void;
}

const SILENCE_RMS = 0.01;

export function startEars(stream: MediaStream, clock: Clock, options: { gapMs?: number; pollMs?: number } = {}): Ears {
  const gapMs = options.gapMs ?? 700;
  const pollMs = options.pollMs ?? 100;
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  const state = { speechMs: 0, utterances: 0, peak: 0, silentForMs: gapMs, running: true };
  const loop = async (): Promise<void> => {
    while (state.running) {
      await clock.sleep(pollMs);
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) sum += v * v;
      const rms = Math.sqrt(sum / samples.length);
      state.peak = Math.max(state.peak, rms);
      if (rms > SILENCE_RMS) {
        if (state.silentForMs >= gapMs) state.utterances += 1;
        state.silentForMs = 0;
        state.speechMs += pollMs;
      } else {
        state.silentForMs += pollMs;
      }
    }
  };
  void context.resume().catch(() => undefined);
  void loop();
  return {
    report: () => ({ speechMs: state.speechMs, utterances: state.utterances, peak: Number(state.peak.toFixed(3)) }),
    stop: () => {
      state.running = false;
      source.disconnect();
      void context.close().catch(() => undefined);
    },
  };
}

export interface CaptureReport {
  /** 'browser' for a tab. */
  displaySurface: string | null;
  width: number;
  height: number;
  /** The frames had content: more than one brightness level. */
  nonBlank: boolean;
  trackState: string;
}

export interface Capture {
  report(): CaptureReport;
  /** The current frame of the shared screen as a PNG data URL (full size), or null before the first frame. */
  snapshot(): string | null;
  stop(): void;
}

/** Starts the screen share the way the product does (the shim turns it into a request for this tab) and samples a frame. */
export async function startCaptureProbe(devices: MediaDevices): Promise<Capture> {
  const stream = await devices.getDisplayMedia({ video: true, audio: false });
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error('the screen share returned no video track');
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play();
  // Wait for a first decoded frame.
  for (let i = 0; i < 50 && video.videoWidth === 0; i += 1) await new Promise((r) => setTimeout(r, 100));
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 36;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const sampleNonBlank = (): boolean => {
    if (!ctx || video.videoWidth === 0) return false;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const levels = new Set<number>();
    for (let i = 0; i < data.length; i += 4) levels.add(Math.round(((data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0)) / 24));
    return levels.size > 3;
  };
  let nonBlank = sampleNonBlank();
  return {
    snapshot: () => {
      if (video.videoWidth === 0) return null;
      const full = document.createElement('canvas');
      full.width = video.videoWidth;
      full.height = video.videoHeight;
      full.getContext('2d')?.drawImage(video, 0, 0);
      return full.toDataURL('image/png');
    },
    report: () => {
      nonBlank = nonBlank || sampleNonBlank();
      const settings = track.getSettings() as MediaTrackSettings & { displaySurface?: string };
      return {
        displaySurface: settings.displaySurface ?? null,
        width: settings.width ?? video.videoWidth,
        height: settings.height ?? video.videoHeight,
        nonBlank,
        trackState: track.readyState,
      };
    },
    stop: () => {
      for (const t of stream.getTracks()) t.stop();
      video.srcObject = null;
    },
  };
}
