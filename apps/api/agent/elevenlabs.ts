// ElevenLabs REST calls for the agent module. The key and signed URLs are never logged.
import type { AgentConfig, Json } from './config.ts';
import { isRecord } from './config.ts';
import { AUDIO_EXT } from './sessions.ts';
import type { SessionFiles } from './sessions.ts';

export const AUDIO_MAX = 50 * 1024 * 1024;
export interface ConversationResult { status: number | 'unreachable'; conv?: Json }
export interface AudioResult { status: number | string; ext?: string; bytes?: number }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const base = (conversationId: string): string => `https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(conversationId)}`;

export interface ElevenLabsClient {
  signedUrl(agentId: string): Promise<{ status: number; signedUrl?: string }>;
  getConversation(conversationId: string): Promise<ConversationResult>;
  /** After /finish has answered: wait for a finished transcript if only a partial one is stored, then fetch the audio. */
  finishInBackground(sessionId: string, conversationId: string, partial: boolean): Promise<void>;
}

export function createElevenLabsClient(config: AgentConfig, files: SessionFiles): ElevenLabsClient {
  const headers = { 'xi-api-key': config.elevenLabsApiKey };
  const getConversation = async (conversationId: string): Promise<ConversationResult> => {
    try {
      const r = await config.fetch(base(conversationId), { headers, signal: AbortSignal.timeout(8_000) });
      if (!r.ok) { await r.arrayBuffer().catch(() => {}); return { status: r.status }; }
      const conv: unknown = await r.json();
      return isRecord(conv) ? { status: r.status, conv } : { status: r.status };
    } catch { return { status: 'unreachable' }; }
  };
  const storeAudio = async (id: string, conversationId: string): Promise<AudioResult> => {
    if (await files.hasAudio(id)) return { status: 'exists' };
    const r = await config.fetch(`${base(conversationId)}/audio`, { headers, signal: AbortSignal.timeout(60_000) });
    const type = ((r.headers.get('content-type') ?? '').split(';')[0] ?? '').trim().toLowerCase();
    const ext = AUDIO_EXT[type];
    if (!r.ok || !ext || !r.body) { await r.arrayBuffer().catch(() => {}); return { status: r.status }; }
    if (Number(r.headers.get('content-length') ?? 0) > AUDIO_MAX) { await r.body.cancel().catch(() => {}); return { status: 'too_large' }; }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const c of r.body) {
      size += c.length;
      if (size > AUDIO_MAX) return { status: 'too_large' };
      chunks.push(c);
    }
    await files.storeAudio(id, ext, Buffer.concat(chunks));
    return { status: r.status, ext, bytes: size };
  };
  return {
    async signedUrl(agentId: string) {
      const url = `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`;
      const r = await config.fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) { await r.arrayBuffer().catch(() => {}); return { status: r.status }; }
      const j: unknown = await r.json();
      const signedUrl = isRecord(j) ? j.signed_url : undefined;
      return typeof signedUrl === 'string' ? { status: r.status, signedUrl } : { status: r.status };
    },
    getConversation,
    async finishInBackground(id, conversationId, partial) {
      const t0 = config.now();
      let conversationStatus: unknown = null;
      try {
        while (partial && config.now() - t0 < config.timing.backgroundWaitMs) {
          await sleep(config.timing.backgroundPollMs);
          const g = await getConversation(conversationId);
          if (g.conv) {
            conversationStatus = g.conv.status ?? null;
            if (g.conv.status === 'done' || g.conv.status === 'failed') { await files.storeTranscript(id, g.conv); partial = false; }
          } else if (typeof g.status === 'number' && g.status < 500 && g.status !== 429) break;
        }
        const a = await storeAudio(id, conversationId);
        config.log({ level: 'info', msg: 'finish background done', session: id, partial, conversation_status: conversationStatus, audio_status: a.status, audio_bytes: a.bytes ?? 0, ms: config.now() - t0 });
      } catch {
        config.log({ level: 'error', msg: 'finish background failed', session: id, ms: config.now() - t0 });
      }
    },
  };
}

export { sleep };
