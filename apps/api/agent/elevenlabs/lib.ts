// Shared helpers for the ElevenLabs spike scripts. Never prints the API key or signed URLs.
import type { ApiOptions, ApiResult } from './types.ts';

export const BASE = 'https://api.elevenlabs.io';

export function apiKey(): string {
  const k = process.env['ELEVENLABS_API_KEY'];
  if (!k) {
    console.error('ELEVENLABS_API_KEY is not set');
    process.exit(2);
  }
  return k;
}

export async function api(path: string, { method = 'GET', body }: ApiOptions = {}): Promise<ApiResult> {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'xi-api-key': apiKey(), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  return { ok: res.ok, status: res.status, json };
}

export function agentId(): string {
  const id = process.env['ELEVENLABS_AGENT_ID_INTERVIEWER'];
  if (!id) {
    console.error('ELEVENLABS_AGENT_ID_INTERVIEWER is not set (run provision.ts, then export the printed id)');
    process.exit(2);
  }
  return id;
}
