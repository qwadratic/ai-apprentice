// The real connector (ElevenLabs Agents web SDK). The SDK is loaded on
// first use so that the first paint does not wait for it (and it stays out of the entry chunk).
import type { VoiceConnector, VoiceMode } from './types.ts';

function messageOf(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

export const connectElevenLabs: VoiceConnector = async (signedUrl, events, signal) => {
  const { Conversation } = await import('@elevenlabs/client');
  // Ended while the SDK chunk was loading: never open the microphone.
  if (signal.aborted) throw new Error('Voice connection cancelled.');
  const conversation = await Conversation.startSession({
    signedUrl,
    // Fires once the microphone and the socket are set up, before onConnect: if the session was ended while the
    // handshake was running, close it here so the microphone does not stay open until startSession returns.
    onConversationCreated: (created) => {
      if (signal.aborted) void created.endSession().catch(() => {});
    },
    onConnect: (props) => { events.onConnect(props?.conversationId ?? ''); },
    onDisconnect: (details) => {
      const reason = details && typeof details === 'object' && 'reason' in details ? String(details.reason) : '';
      events.onDisconnect(reason);
    },
    onStatusChange: ({ status }) => { events.onStatus(status); },
    onModeChange: ({ mode }) => { events.onMode(mode as VoiceMode); },
    onMessage: (m) => { events.onMessage({ source: m.source === 'ai' ? 'ai' : 'user', text: m.message }); },
    onVadScore: ({ vadScore }) => { events.onVadScore?.(vadScore); },
    onError: (message, context) => {
      events.onError(messageOf(message));
      if (context) events.onError(messageOf(context));
    },
  });
  return {
    // onConnect delivers the id; getId() (BaseConversation, SDK 1.26.0) is the fallback.
    conversationId: () => {
      try { return conversation.getId() || ''; } catch { return ''; }
    },
    sendContextualUpdate: (text) => { conversation.sendContextualUpdate(text); },
    sendUserMessage: (text) => { conversation.sendUserMessage(text); },
    setMicMuted: (muted) => { conversation.setMicMuted(muted); },
    end: async () => { await conversation.endSession(); },
  };
};
