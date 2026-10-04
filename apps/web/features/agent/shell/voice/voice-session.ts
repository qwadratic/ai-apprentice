import { askMessage } from './context.ts';
import type { VoiceConnector, VoiceEvents, VoiceHandle } from './types.ts';

/** How long ending the conversation may take before the shell stops waiting (the microphone must close). */
export const VOICE_END_TIMEOUT_MS = 3000;

/**
 * One ElevenAgents conversation. It knows only whether it can be used: the policy (when to ask) is the brain's
 * and the session limits belong to the controller.
 *
 * The real SDK (1.26.0) fires onStatusChange('connected') and onConnect from inside startSession, before it returns
 * the conversation. Until `start()` has the handle nothing can be sent, so `isConnected()` is false in that window
 * even though the connected events already arrived, and callers keep their context buffered (`isOpening()`).
 */
export class VoiceSession {
  private readonly connector: VoiceConnector;
  private readonly abort = new AbortController();
  private handle: VoiceHandle | null = null;
  private connected = false;
  private ended = false;
  private started = false;

  constructor(connector: VoiceConnector) {
    this.connector = connector;
  }

  /** The conversation is open and has a handle: sends reach the agent. */
  isConnected(): boolean {
    return this.handle !== null && this.connected && !this.ended;
  }

  /** Not usable yet, but it may become usable: still connecting. False once ended. */
  isOpening(): boolean {
    return !this.ended && !this.isConnected();
  }

  /** Opens the conversation. Rejects when the connection cannot be made; the signed URL is never put into an error. */
  async start(signedUrl: string, events: VoiceEvents): Promise<void> {
    if (this.started || this.ended) throw new Error('This voice session was already used.');
    this.started = true;
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
    const handle = await this.connector(signedUrl, wrapped, this.abort.signal);
    if (this.ended) {
      // The session was ended while the connection was being made: close it the moment it opens.
      await handle.end().catch(() => {});
      return;
    }
    this.handle = handle;
  }

  conversationId(): string {
    if (!this.handle) return '';
    try { return this.handle.conversationId(); } catch { return ''; }
  }

  /** Returns false (and sends nothing) when the conversation cannot be written to yet or any more. */
  sendContext(text: string): boolean {
    if (!this.handle || !this.isConnected()) return false;
    this.handle.sendContextualUpdate(text);
    return true;
  }

  /**
   * Speaks `text` through the agent: it is sent as `[ASK] text`. Returns the message that was sent, or null. `maxChars` raises the
   * usual limit for a line that must be read in full (the conductor's teach-back).
   */
  ask(text: string, maxChars?: number): string | null {
    if (!this.handle || !this.isConnected()) return null;
    const message = askMessage(text, maxChars);
    this.handle.sendUserMessage(message);
    return message;
  }

  /**
   * Ends the conversation. Safe to call twice; waits at most VOICE_END_TIMEOUT_MS. While the connection is still being
   * made the connector is told to abort (the SDK has no way to cancel the handshake itself, so the microphone closes as
   * soon as the conversation object exists).
   */
  async end(timeoutMs: number = VOICE_END_TIMEOUT_MS): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.connected = false;
    this.abort.abort();
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
