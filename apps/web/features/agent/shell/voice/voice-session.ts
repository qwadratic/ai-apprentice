import { askMessage } from './context.ts';
import type { VoiceConnector, VoiceEvents, VoiceHandle } from './types.ts';

/** How long ending the conversation may take before the shell stops waiting (the microphone must close). */
export const VOICE_END_TIMEOUT_MS = 3000;

/**
 * One ElevenAgents conversation. It knows only whether it is connected: the policy (when to ask) is the brain's
 * and the session limits belong to the controller.
 */
export class VoiceSession {
  private readonly connector: VoiceConnector;
  private handle: VoiceHandle | null = null;
  private connected = false;
  private ended = false;

  constructor(connector: VoiceConnector) {
    this.connector = connector;
  }

  isConnected(): boolean {
    return this.connected && !this.ended;
  }

  /** Opens the conversation. Rejects when the connection cannot be made; the signed URL is never put into an error. */
  async start(signedUrl: string, events: VoiceEvents): Promise<void> {
    if (this.handle || this.ended) throw new Error('This voice session was already used.');
    const wrapped: VoiceEvents = {
      ...events,
      onConnect: (id) => { this.connected = true; events.onConnect(id); },
      onDisconnect: (reason) => { this.connected = false; events.onDisconnect(reason); },
      onStatus: (status) => {
        if (status === 'connected') this.connected = true;
        else if (status === 'disconnected') this.connected = false;
        events.onStatus(status);
      },
    };
    const handle = await this.connector(signedUrl, wrapped);
    if (this.ended) {
      // The session was ended while the connection was being made: close it at once.
      await handle.end().catch(() => {});
      return;
    }
    this.handle = handle;
  }

  conversationId(): string {
    if (!this.handle) return '';
    try { return this.handle.conversationId(); } catch { return ''; }
  }

  /** Returns false (and sends nothing) when the conversation is not connected. */
  sendContext(text: string): boolean {
    if (!this.handle || !this.isConnected()) return false;
    this.handle.sendContextualUpdate(text);
    return true;
  }

  /** Speaks `text` through the agent: it is sent as `[ASK] text`. Returns the message that was sent, or null. */
  ask(text: string): string | null {
    if (!this.handle || !this.isConnected()) return null;
    const message = askMessage(text);
    this.handle.sendUserMessage(message);
    return message;
  }

  /** Ends the conversation. Safe to call twice; waits at most VOICE_END_TIMEOUT_MS. */
  async end(timeoutMs: number = VOICE_END_TIMEOUT_MS): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.connected = false;
    const handle = this.handle;
    this.handle = null;
    if (!handle) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); });
    try {
      await Promise.race([handle.end().catch(() => {}), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
