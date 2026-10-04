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
}

export interface VoiceHandle {
  conversationId(): string;
  /** Background context for the agent. It does not make the agent speak. */
  sendContextualUpdate(text: string): void;
  /** A user-side message. The live agent answers `[ASK] <text>` by saying <text> verbatim and otherwise stays silent. */
  sendUserMessage(text: string): void;
  end(): Promise<void>;
}

/** Opens one conversation on a signed URL (a secret: never logged). */
export type VoiceConnector = (signedUrl: string, events: VoiceEvents) => Promise<VoiceHandle>;
