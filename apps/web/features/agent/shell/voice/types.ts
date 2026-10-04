// The voice boundary. The shell talks to ElevenAgents only through VoiceConnector, so tests use a fake and the real
// connector (elevenlabs.ts) loads the SDK lazily.

export type VoiceMode = 'speaking' | 'listening';

export interface VoiceMessage {
  source: 'ai' | 'user';
  text: string;
}

export interface VoiceEvents {
  onConnect(conversationId: string): void;
  /** `reason` is a short text from the SDK; it may be empty. */
  onDisconnect(reason: string): void;
  onStatus(status: string): void;
  onMode(mode: VoiceMode): void;
  onMessage(message: VoiceMessage): void;
  onError(message: string): void;
  /** Voice activity of the person's microphone, 0 to 1, while the conversation is open. Optional: not every connector reports it. */
  onVadScore?(score: number): void;
}

export interface VoiceHandle {
  conversationId(): string;
  /** Background context for the agent. It does not make the agent speak. */
  sendContextualUpdate(text: string): void;
  /** A user-side message. The live agent answers `[ASK] <text>` by saying <text> verbatim and otherwise stays silent. */
  sendUserMessage(text: string): void;
  /** Mutes or unmutes the microphone; the conversation stays open. */
  setMicMuted?(muted: boolean): void;
  end(): Promise<void>;
}

/**
 * Opens one conversation on a signed URL (a secret: never logged). `signal` aborts when the session is ended while
 * the connection is still being made: the connector must then close what it opened (the microphone) as soon as it can.
 */
export type VoiceConnector = (signedUrl: string, events: VoiceEvents, signal: AbortSignal) => Promise<VoiceHandle>;
