// Types and small validators for the ElevenLabs API shapes the spike scripts use.
// Only the fields we read are typed; everything from the network is `unknown` until a validator has checked it.
// Never put secrets (API key, signed URLs) into anything defined here that gets logged.

export type JsonRecord = Record<string, unknown>;

export function isRecord(v: unknown): v is JsonRecord {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

/** Result of lib.api(). `json` is the parsed body, or `{ raw: <first 500 chars> }` when the body is not JSON. */
export interface ApiResult {
  ok: boolean;
  status: number;
  json: unknown;
}

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
}

/** GET /v1/user/subscription. The response has many more fields (see check-account.ts, which lists the keys). */
export interface Subscription extends JsonRecord {
  tier?: string;
  status?: string;
  character_count?: number;
  character_limit?: number;
  voice_limit?: number;
  voice_slots_used?: number;
  professional_voice_limit?: number;
  can_use_instant_voice_cloning?: boolean;
  can_use_professional_voice_cloning?: boolean;
  next_character_count_reset_unix?: number;
  billing_period?: string;
  currency?: string;
}

/** Object bodies are kept whole (unknown extra keys included); anything else is not a usable body. */
export function parseSubscription(json: unknown): Subscription {
  return isRecord(json) ? json : {};
}

/** One entry of GET /v1/convai/agents (`agents` array). */
export interface AgentSummary {
  agent_id: string;
  name: string;
}

export function parseAgentList(json: unknown): AgentSummary[] {
  if (!isRecord(json) || !Array.isArray(json['agents'])) return [];
  const out: AgentSummary[] = [];
  for (const a of json['agents'] as unknown[]) {
    if (!isRecord(a)) continue;
    const agent_id = str(a['agent_id']);
    const name = str(a['name']);
    if (agent_id !== undefined && name !== undefined) out.push({ agent_id, name });
  }
  return out;
}

/** POST /v1/convai/agents/create reply. */
export function parseCreatedAgentId(json: unknown): string | undefined {
  return isRecord(json) ? str(json['agent_id']) : undefined;
}

/** GET /v1/convai/conversation/get-signed-url reply. The URL is a secret: never log it. */
export interface SignedUrlResponse {
  signed_url: string;
}

export function parseSignedUrlResponse(json: unknown): SignedUrlResponse | undefined {
  const signed_url = isRecord(json) ? str(json['signed_url']) : undefined;
  return signed_url === undefined ? undefined : { signed_url };
}

// ---------------------------------------------------------------------------
// Agent config (agents.config.json, sent to create / PATCH)
// ---------------------------------------------------------------------------

export interface BuiltInToolConfig {
  name: string;
  description: string;
  params: { system_tool_type: string };
}

export interface AgentConfig {
  name: string;
  tags?: string[];
  conversation_config: {
    agent?: {
      first_message?: string;
      language?: string;
      prompt?: {
        prompt?: string;
        llm?: string;
        built_in_tools?: Record<string, BuiltInToolConfig | null>;
      };
    };
    turn?: { turn_timeout?: number; turn_eagerness?: string };
    conversation?: { text_only?: boolean; max_duration_seconds?: number; client_events?: string[] };
    tts?: { model_id?: string; voice_id?: string };
  };
  platform_settings?: {
    auth?: { enable_auth?: boolean };
    overrides?: unknown;
  };
}

/** Checks the fields provision.ts depends on; the rest of the file is passed through to the API unchanged. */
export function parseAgentConfig(json: unknown): AgentConfig {
  if (!isRecord(json) || typeof json['name'] !== 'string' || !isRecord(json['conversation_config'])) {
    throw new Error('agents.config.json: expected an object with a string "name" and a "conversation_config" object');
  }
  // Narrowed by the checks above; deeper fields are optional and only read defensively.
  return json as unknown as AgentConfig;
}

/** The parts of GET /v1/convai/agents/{id} that provision.ts prints as the read-back. */
export interface AgentReadback {
  conversation_config?: AgentConfig['conversation_config'];
  platform_settings?: AgentConfig['platform_settings'];
}

export function parseAgentReadback(json: unknown): AgentReadback {
  if (!isRecord(json)) return {};
  const out: AgentReadback = {};
  const cc = json['conversation_config'];
  if (isRecord(cc)) out.conversation_config = cc as AgentConfig['conversation_config'];
  const ps = json['platform_settings'];
  if (isRecord(ps)) out.platform_settings = ps as AgentConfig['platform_settings'];
  return out;
}

// ---------------------------------------------------------------------------
// WebSocket protocol (ElevenAgents conversation socket, text-only use)
// ---------------------------------------------------------------------------

/** Events the client sends. */
export type ClientEvent =
  | {
      type: 'conversation_initiation_client_data';
      conversation_config_override: { conversation: { text_only: boolean } };
    }
  | { type: 'pong'; event_id: number }
  | { type: 'contextual_update'; text: string }
  | { type: 'user_message'; text: string };

export interface PingEvent {
  type: 'ping';
  ping_event: { event_id: number; ping_ms?: number };
}

export interface MetadataEvent {
  type: 'conversation_initiation_metadata';
  conversation_initiation_metadata_event: JsonRecord & { agent_output_audio_format?: string };
}

export interface AudioEvent {
  type: 'audio';
}

export interface AgentResponseEvent {
  type: 'agent_response';
  agent_response_event: { agent_response?: string };
}

export interface TextResponsePart {
  type: 'start' | 'delta' | 'stop';
  text?: string;
  event_id?: number;
  response_id: number | string;
}

export interface AgentChatResponsePartEvent {
  type: 'agent_chat_response_part';
  text_response_part: TextResponsePart;
}

/** Events the script ignores in its own handling (`user_transcript`, `vad_score`). */
export interface IgnoredEvent {
  type: 'user_transcript' | 'vad_score';
}

/** Any other event, or a known one whose payload did not validate. Kept whole for logging. */
export interface OtherEvent {
  type: 'other';
  eventType: string;
  raw: JsonRecord;
}

export type ServerEvent =
  | PingEvent
  | MetadataEvent
  | AudioEvent
  | AgentResponseEvent
  | AgentChatResponsePartEvent
  | IgnoredEvent
  | OtherEvent;

/** Parses a raw WebSocket message (a JSON string). Returns undefined when it is not a JSON object with a string `type`. */
export function parseServerEvent(data: unknown): ServerEvent | undefined {
  if (typeof data !== 'string') return undefined;
  let m: unknown;
  try {
    m = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (!isRecord(m)) return undefined;
  const type = str(m['type']);
  if (type === undefined) return undefined;
  const other: OtherEvent = { type: 'other', eventType: type, raw: m };

  switch (type) {
    case 'ping': {
      const p = m['ping_event'];
      if (!isRecord(p)) return other;
      const event_id = num(p['event_id']);
      if (event_id === undefined) return other;
      const ping_ms = num(p['ping_ms']);
      return { type, ping_event: ping_ms === undefined ? { event_id } : { event_id, ping_ms } };
    }
    case 'conversation_initiation_metadata': {
      const e = m['conversation_initiation_metadata_event'];
      return isRecord(e) ? { type, conversation_initiation_metadata_event: e } : other;
    }
    case 'audio':
      return { type };
    case 'agent_response': {
      const e = m['agent_response_event'];
      if (e !== undefined && !isRecord(e)) return other;
      const text = isRecord(e) ? str(e['agent_response']) : undefined;
      return { type, agent_response_event: text === undefined ? {} : { agent_response: text } };
    }
    case 'agent_chat_response_part': {
      const p = m['text_response_part'];
      if (!isRecord(p)) return other;
      const pt = p['type'];
      const rid = p['response_id'];
      if ((pt !== 'start' && pt !== 'delta' && pt !== 'stop') || (typeof rid !== 'number' && typeof rid !== 'string')) {
        return other;
      }
      const part: TextResponsePart = { type: pt, response_id: rid };
      const text = str(p['text']);
      if (text !== undefined) part.text = text;
      return { type, text_response_part: part };
    }
    case 'user_transcript':
    case 'vad_score':
      return { type };
    default:
      return other;
  }
}
