// A small Server-Sent Events parser for a fetch stream (EventSource cannot send the Authorization header).
// It follows the event-stream format: lines split on CRLF, LF or CR; `event`, `data` (joined with "\n"), `id`;
// a blank line dispatches; a line starting with ':' is a comment (the server's keep-alive ping).

export interface SseMessage {
  event: string;
  data: string;
  id: string | null;
}

export class SseParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];
  private id: string | null = null;
  private readonly onMessage: (message: SseMessage) => void;

  constructor(onMessage: (message: SseMessage) => void) {
    this.onMessage = onMessage;
  }

  /** Feeds a decoded chunk; complete messages are dispatched in order. */
  push(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const match = /\r\n|\n|\r/.exec(this.buffer);
      if (match === null) break;
      // A CR at the very end may be the first half of a CRLF split across chunks: wait for the next chunk.
      if (match[0] === '\r' && match.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      this.line(line);
    }
  }

  /** Drops a half-read message (the stream broke): the next stream starts clean. */
  reset(): void {
    this.buffer = '';
    this.event = '';
    this.data = [];
    this.id = null;
  }

  private line(line: string): void {
    if (line === '') {
      if (this.data.length > 0) this.onMessage({ event: this.event || 'message', data: this.data.join('\n'), id: this.id });
      this.event = '';
      this.data = [];
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
    else if (field === 'id') this.id = value;
  }
}
