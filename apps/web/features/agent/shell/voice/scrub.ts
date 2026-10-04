// Signed WebSocket URLs, API keys and bearer tokens never reach the visible log or the server log.
export function scrub(text: unknown): string {
  return String(text)
    .replace(/wss?:\/\/\S+/gi, '[url removed]')
    .replace(/xi-api-key\s*[:=]?\s*\S*/gi, '[key removed]')
    .replace(/sk_[A-Za-z0-9]{16,}/g, '[key removed]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [token removed]');
}
