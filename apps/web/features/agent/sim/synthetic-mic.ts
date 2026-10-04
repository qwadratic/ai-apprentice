// A synthetic microphone: a MediaStream fed by pre-rendered clips (WebAudio: AudioContext -> MediaStreamAudioDestinationNode).
// The voice agent hears it through its normal speech-to-text, exactly as it would hear a person. Nothing here talks to a
// network or an agent: the caller says which clip to play and when (the persona driver does that when the agent asks).
//
// say(clipId) plays one clip and resolves when it has been played to the end. Clips never overlap: a second say() waits
// for the first (a person does not talk over themselves). stop() cancels what is playing and what is queued.
// Idle, the stream carries silence, like a real microphone in a quiet room.

/** The part of an AudioBuffer the mic needs. */
export interface AudioBufferLike {
  readonly duration: number;
}

/** The part of an AudioBufferSourceNode the mic needs. */
export interface BufferSourceLike {
  buffer: AudioBufferLike | null;
  onended: ((event: Event) => void) | null;
  connect(destination: unknown): unknown;
  start(when?: number): void;
  stop(when?: number): void;
  disconnect(): void;
}

/** The part of a GainNode the mic needs. */
export interface GainLike {
  readonly gain: { value: number };
  connect(destination: unknown): unknown;
  disconnect(): void;
}

/** The part of an AudioContext the mic needs; the real AudioContext satisfies it, tests pass a fake. */
export interface AudioContextLike {
  readonly state: string;
  readonly destination: unknown;
  resume(): Promise<void>;
  close(): Promise<void>;
  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike>;
  createBufferSource(): BufferSourceLike;
  createGain(): GainLike;
  createMediaStreamDestination(): { readonly stream: MediaStream };
}

export type MicEventType = 'queued' | 'start' | 'end' | 'cancelled';
export interface MicEvent {
  type: MicEventType;
  clipId: string;
}

export interface SyntheticMicOptions {
  /** The audio context. By default a new AudioContext (browser only). */
  context?: AudioContextLike;
  /** Gets the bytes of a clip by id (an mp3 file). Called once per clip: decoded buffers are cached. */
  loadClip(clipId: string): Promise<ArrayBuffer>;
  /** Renders text to audio bytes on demand (a live text-to-speech route). Without it the mic has no sayText(). */
  renderText?: (text: string) => Promise<ArrayBuffer>;
  /** Also play the clips through the speakers, so people in the room hear the persona. Off by default. */
  monitor?: boolean;
  /** Observes what the mic does. */
  onEvent?: (event: MicEvent) => void;
  /** Builds a MediaStream from tracks. By default `new MediaStream(tracks)`; tests pass a fake. */
  createStream?: (tracks: MediaStreamTrack[]) => MediaStream;
}

export interface SyntheticMic {
  /** The audio stream to hand to whoever asks for a microphone. Use cloneStream() for each consumer. */
  readonly stream: MediaStream;
  /** A new MediaStream with cloned tracks: a consumer that stops its tracks does not end the mic. */
  cloneStream(): MediaStream;
  /** Plays a clip; resolves when it has ended. Rejects if the clip cannot be loaded or the mic was stopped. */
  say(clipId: string): Promise<void>;
  /** Plays rendered text. Present only when the mic was created with renderText. */
  sayText?: (text: string) => Promise<void>;
  /** Decodes clips ahead of time so the first answer does not wait for a decode. */
  preload(clipIds: readonly string[]): Promise<void>;
  /** Resumes the audio context; call it in a user gesture (browsers keep a new context suspended until then). */
  resume(): Promise<void>;
  isSpeaking(): boolean;
  /** Cancels what is playing and queued, ends the tracks and closes the context. */
  stop(): void;
}

interface Playing {
  source: BufferSourceLike;
  clipId: string;
  finish(): void;
}

export class MicStoppedError extends Error {
  constructor() {
    super('the synthetic microphone was stopped');
    this.name = 'MicStoppedError';
  }
}

export function createSyntheticMic(options: SyntheticMicOptions): SyntheticMic {
  const context: AudioContextLike = options.context ?? defaultContext();
  const destination = context.createMediaStreamDestination();
  const out = context.createGain();
  out.connect(destination);
  if (options.monitor) out.connect(context.destination);

  const decoded = new Map<string, Promise<AudioBufferLike>>();
  const emit = (type: MicEventType, clipId: string): void => options.onEvent?.({ type, clipId });
  let stopped = false;
  let playing: Playing | null = null;
  // The tail of the queue: each say() chains onto it, so clips play one after another in the order they were asked for.
  let tail: Promise<void> = Promise.resolve();
  // Bumped by stop(): queued clips from an earlier epoch do not play.
  let epoch = 0;

  const decode = (key: string, bytes: () => Promise<ArrayBuffer>): Promise<AudioBufferLike> => {
    let found = decoded.get(key);
    if (found === undefined) {
      // decodeAudioData detaches the buffer it is given, so every decode gets its own copy.
      found = bytes().then((data) => context.decodeAudioData(data.slice(0)));
      decoded.set(key, found);
      // A failed load is not cached: the next say() tries again.
      found.catch(() => decoded.delete(key));
    }
    return found;
  };

  const play = (clipId: string, buffer: AudioBufferLike): Promise<void> =>
    new Promise<void>((resolve) => {
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(out);
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        source.onended = null;
        try {
          source.disconnect();
        } catch {
          // already disconnected
        }
        if (playing?.source === source) playing = null;
        resolve();
      };
      source.onended = finish;
      playing = { source, clipId, finish };
      emit('start', clipId);
      source.start();
    });

  const enqueue = (clipId: string, buffer: () => Promise<AudioBufferLike>): Promise<void> => {
    if (stopped) return Promise.reject(new MicStoppedError());
    const myEpoch = epoch;
    emit('queued', clipId);
    const run = async (): Promise<void> => {
      // Decoding starts at once (in parallel with a clip that is still playing); playing waits for the turn.
      const ready = buffer();
      await tail.catch(() => undefined);
      if (stopped || myEpoch !== epoch) {
        ready.catch(() => undefined);
        emit('cancelled', clipId);
        throw new MicStoppedError();
      }
      const audio = await ready;
      if (stopped || myEpoch !== epoch) {
        emit('cancelled', clipId);
        throw new MicStoppedError();
      }
      if (context.state === 'suspended') await context.resume();
      await play(clipId, audio);
      // stop() ends the clip that is playing; that is a cancellation, not an end.
      if (stopped || myEpoch !== epoch) throw new MicStoppedError();
      emit('end', clipId);
    };
    const result = run();
    tail = result.catch(() => undefined);
    return result;
  };

  const mic: SyntheticMic = {
    stream: destination.stream,
    cloneStream: () => {
      const tracks = destination.stream.getAudioTracks().map((track) => track.clone());
      return options.createStream ? options.createStream(tracks) : new MediaStream(tracks);
    },
    say: (clipId) => enqueue(clipId, () => decode(clipId, () => options.loadClip(clipId))),
    preload: async (clipIds) => {
      await Promise.all(clipIds.map((id) => decode(id, () => options.loadClip(id))));
    },
    resume: async () => {
      if (!stopped && context.state === 'suspended') await context.resume();
    },
    isSpeaking: () => playing !== null,
    stop: () => {
      if (stopped) return;
      stopped = true;
      epoch += 1;
      const current = playing;
      if (current) {
        emit('cancelled', current.clipId);
        try {
          current.source.stop();
        } catch {
          // not started or already ended
        }
        current.finish();
      }
      for (const track of destination.stream.getTracks()) track.stop();
      void context.close().catch(() => undefined);
    },
  };
  const renderText = options.renderText;
  if (renderText) {
    let counter = 0;
    mic.sayText = (text) => {
      counter += 1;
      const key = `text:${counter}`;
      return enqueue(key, () => decode(key, () => renderText(text)));
    };
  }
  return mic;
}

function defaultContext(): AudioContextLike {
  if (typeof AudioContext === 'undefined') throw new Error('AudioContext is not available here: pass options.context');
  return new AudioContext();
}
