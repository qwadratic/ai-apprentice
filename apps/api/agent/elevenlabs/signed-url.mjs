// Step 3: mint a signed URL for the interviewer agent. Prints only status and host, never the URL.
// Exported getSignedUrl() is reused by textonly-test.mjs.
import { pathToFileURL } from 'node:url';
import { api, agentId } from './lib.mjs';

export async function getSignedUrl(id = agentId()) {
  const r = await api(`/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(id)}`);
  if (!r.ok) return { ok: false, status: r.status, error: JSON.stringify(r.json).slice(0, 300) };
  return { ok: true, status: r.status, url: r.json.signed_url };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = await getSignedUrl();
  if (!r.ok) {
    console.log('signed-url failed', r.status, r.error);
    process.exit(1);
  }
  const u = new URL(r.url);
  console.log(`ok status=${r.status} protocol=${u.protocol} host=${u.host} path=${u.pathname}`);
}
