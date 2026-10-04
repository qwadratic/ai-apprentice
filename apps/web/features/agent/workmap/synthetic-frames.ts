// Generated placeholder frames for sample and demo sessions: a small SVG sketch of the demo workspace drawn from an
// observation's facts, titled "Synthetic sketch". They stand in for A's processed frames when no real capture exists and are
// always reported as synthetic, so the board labels them. Not a screen capture.
import type { ScreenEvidence, ScreenObservation } from '@apprentice/contracts';
import type { ResolveEvidence, ResolvedEvidence } from './model.ts';

const W = 320;
const H = 200;

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function cut(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function chrome(title: string, active: 'order' | 'email' | 'ticket'): string {
  const tab = (x: number, label: string, on: boolean): string =>
    `<rect x="${x}" y="30" width="58" height="18" rx="4" fill="${on ? '#0a766f' : '#e3ebe9'}"/>` +
    `<text x="${x + 29}" y="43" font-size="9" text-anchor="middle" fill="${on ? '#fff' : '#4f605c'}">${label}</text>`;
  return (
    `<rect width="${W}" height="${H}" rx="8" fill="#f6f9f8"/>` +
    `<rect width="${W}" height="24" rx="8" fill="#dfe8e6"/><rect y="16" width="${W}" height="8" fill="#dfe8e6"/>` +
    `<circle cx="12" cy="12" r="3.5" fill="#e07a6f"/><circle cx="23" cy="12" r="3.5" fill="#e8c26a"/><circle cx="34" cy="12" r="3.5" fill="#79c08f"/>` +
    `<text x="${W / 2}" y="15.5" font-size="9" text-anchor="middle" fill="#4f605c">${esc(title)}</text>` +
    tab(10, 'Orders', active === 'order') +
    tab(72, 'Email', active === 'email') +
    tab(134, 'Ticket', active === 'ticket')
  );
}

function line(x: number, y: number, label: string, value: string, bold = false): string {
  return (
    `<text x="${x}" y="${y}" font-size="9" fill="#4f605c">${esc(label)}</text>` +
    `<text x="${x + 62}" y="${y}" font-size="9" fill="#14211f"${bold ? ' font-weight="700"' : ''}>${esc(value)}</text>`
  );
}

function orderSvg(o: Extract<ScreenObservation, { kind: 'order_view' }>): string {
  const f = o.facts;
  let rows = '';
  const others = [
    ['customer_03', 'ORD-2037'],
    ['customer_12', 'ORD-2039'],
  ];
  others.forEach(([c, id], i) => {
    const y = 68 + i * 18;
    rows += `<text x="18" y="${y}" font-size="9" fill="#6b7c78">${c}</text><text x="100" y="${y}" font-size="9" fill="#6b7c78">${id}</text>`;
    rows += `<rect x="170" y="${y - 7}" width="${110 - i * 20}" height="6" rx="3" fill="#d5dfdc"/>`;
  });
  const y = 104;
  rows +=
    `<rect x="10" y="${y - 12}" width="${W - 20}" height="18" rx="4" fill="#d8efec" stroke="#0a766f" stroke-width="1"/>` +
    `<text x="18" y="${y}" font-size="9" font-weight="700" fill="#0a766f">${esc(f.customerRef ?? 'unknown')}</text>` +
    `<text x="100" y="${y}" font-size="9" font-weight="700" fill="#14211f">${esc(f.orderId ?? '—')}</text>` +
    `<text x="170" y="${y}" font-size="9" fill="#14211f">${esc(cut(f.deliveryWindow ?? '', 26))}</text>`;
  return (
    chrome('Synthetic sketch — orders', 'order') +
    `<text x="18" y="62" font-size="8" fill="#8a9a96" letter-spacing="0.6">CUSTOMER          ORDER             DELIVERY</text>`.replace(/ {2,}/g, (m) => ' '.repeat(m.length)) +
    rows +
    line(18, 136, 'Address', cut(f.deliveryAddress ?? '—', 34)) +
    line(18, 152, 'Window', cut(f.deliveryWindow ?? '—', 34))
  );
}

function emailSvg(o: Extract<ScreenObservation, { kind: 'email_draft' }>): string {
  const f = o.facts;
  const preview = f.previewState !== 'editing';
  let body = '';
  const lines = f.bodyText.split('\n').filter((l) => l.trim().length > 0).slice(0, 4);
  if (lines.length === 0) {
    body = `<rect x="18" y="104" width="120" height="6" rx="3" fill="#e3ebe9"/><text x="18" y="100" font-size="8" fill="#a3b0ad">Write your message…</text>`;
  } else {
    lines.forEach((l, i) => {
      body += `<text x="18" y="${104 + i * 13}" font-size="9" fill="#14211f">${esc(cut(l, 52))}</text>`;
    });
  }
  let att = '';
  f.attachments.forEach((a, i) => {
    const x = 18 + i * 96;
    att +=
      `<g transform="translate(${x},152)"><rect width="88" height="22" rx="5" fill="#fff" stroke="#b8c7c3"/>` +
      `<rect x="4" y="4" width="18" height="14" rx="2" fill="#a8d5cf"/><path d="M6 16 l5 -6 l4 4 l3 -3 l3 5 z" fill="#0a766f"/>` +
      `<text x="27" y="14.5" font-size="8" fill="#14211f">${esc(a.kind)} attachment</text></g>`;
  });
  return (
    chrome(preview ? 'Synthetic sketch — email preview' : 'Synthetic sketch — email', 'email') +
    line(18, 66, 'To', f.recipientRef ?? '(not recognised)') +
    line(18, 81, 'Subject', cut(f.subject, 38), true) +
    `<line x1="12" y1="88" x2="${W - 12}" y2="88" stroke="#d5dfdc"/>` +
    body +
    att +
    (preview
      ? `<g transform="translate(${W - 92},32)"><rect width="80" height="16" rx="8" fill="${f.previewState === 'sent' ? '#0b6b4c' : '#8a5300'}"/>` +
        `<text x="40" y="11" font-size="8.5" text-anchor="middle" fill="#fff">${f.previewState === 'sent' ? 'Sent' : 'Preview'}</text></g>`
      : '')
  );
}

function ticketSvg(o: Extract<ScreenObservation, { kind: 'ticket' }>): string {
  const f = o.facts;
  return (
    chrome('Synthetic sketch — ticket', 'ticket') +
    line(18, 70, 'Ticket', f.ticketId, true) +
    line(18, 86, 'Order', f.orderId ?? '—') +
    line(18, 102, 'Customer', f.customerRef ?? '—') +
    line(18, 118, 'Note', cut(f.summary || '(empty)', 34)) +
    `<g transform="translate(18,132)"><rect width="56" height="16" rx="8" fill="${f.status === 'done' ? '#0b6b4c' : '#4f605c'}"/>` +
    `<text x="28" y="11" font-size="8.5" text-anchor="middle" fill="#fff">${f.status}</text></g>`
  );
}

/** An SVG data URL sketching what the observation reports. Input-activity heartbeats have no frame. */
export function syntheticFrameUrl(observation: ScreenObservation): string | null {
  let inner: string;
  if (observation.kind === 'order_view') inner = orderSvg(observation);
  else if (observation.kind === 'email_draft') inner = emailSvg(observation);
  else if (observation.kind === 'ticket') inner = ticketSvg(observation);
  else return null;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="system-ui, -apple-system, Segoe UI, sans-serif">${inner}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * A resolveEvidence for sample sessions: each evidence id resolves to a generated frame of the first observation that cites it.
 * Every result is marked synthetic.
 */
export function syntheticEvidenceResolver(
  observations: readonly ScreenObservation[],
  evidence: readonly ScreenEvidence[] = [],
): ResolveEvidence {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  return async (id: string): Promise<ResolvedEvidence | null> => {
    const obs = observations.find((o) => o.evidenceIds.includes(id));
    if (obs === undefined) return null;
    const url = syntheticFrameUrl(obs);
    if (url === null) return null;
    const ev = byId.get(id);
    return {
      url,
      startMs: ev?.startMs ?? obs.timestampMs,
      endMs: ev?.endMs ?? obs.timestampMs + 1000,
      kind: ev?.kind ?? 'frame',
      synthetic: true,
    };
  };
}
