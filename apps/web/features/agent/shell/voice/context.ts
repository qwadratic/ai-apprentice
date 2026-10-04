// What the shell says to the voice agent besides the question itself.
import type { ScreenObservation } from '@apprentice/contracts';
import { isScreenActivity, screenActivityLine, screenActivitySummary } from '../brain/generic.ts';
import type { ScreenActivityObservation } from '../brain/generic.ts';

const MAX_QUESTION_CHARS = 400;

const AUDIO_TAG = /\[[^\]]+\]/g;

/** Text without bracketed audio tags ("[warmly]", "[pause]"): what was really said, for comparing and for the record. */
export function stripAudioTags(text: string): string {
  return text.replace(AUDIO_TAG, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The live agents (interviewer and tutor, v4 turbo) say what follows [ASK] verbatim and otherwise call skip_turn. v4 turbo would
 * perform a bracketed audio tag, so none reaches an [ASK] line by accident: the question text is stripped of them.
 */
export function askMessage(text: string): string {
  const clean = stripAudioTags(text.replace(/^\s*\[ASK\]\s*/i, '')).slice(0, MAX_QUESTION_CHARS);
  return `[ASK] ${clean}`;
}

const show = (value: string | null, fallback: string): string => (value === null || value === '' ? fallback : value);

export const SYNTHETIC_TAG = '(synthetic sample)';

/**
 * One neutral sentence per observation, for sendContextualUpdate. Heartbeats are not sent (they would flood the agent). A line from
 * the sample source says so: the voice agent must never take invented data for the person's screen.
 */
export function observationToContext(o: ScreenObservation, synthetic = false): string | null {
  const line = plainContext(o);
  return line !== null && synthetic ? line.replace(/^\[screen\] /, `[screen] ${SYNTHETIC_TAG} `) : line;
}

function plainContext(o: ScreenObservation): string | null {
  // Generic mode: the 4th kind (not in the contracts yet), one line per screen moment.
  if (isScreenActivity(o as { kind: string })) return screenActivityLine((o as unknown as ScreenActivityObservation).facts);
  switch (o.kind) {
    case 'order_view': {
      const f = o.facts;
      return `[screen] Order ${show(f.orderId, 'unknown')} for ${show(f.customerRef, 'an unknown customer')} is open. ` +
        `Delivery address: ${show(f.deliveryAddress, 'not visible')}. Delivery window: ${show(f.deliveryWindow, 'not visible')}.`;
    }
    case 'email_draft': {
      const f = o.facts;
      const kinds = f.attachments.map((a) => a.kind).join(', ');
      const attachments = f.attachments.length === 0 ? 'no attachments' : `${f.attachments.length} attachment${f.attachments.length === 1 ? '' : 's'} (${kinds})`;
      const body = f.bodyText.trim() === '' ? 'the body is empty' : `the body has ${f.bodyText.length} characters of text`;
      return `[screen] Email draft to ${show(f.recipientRef, 'an unknown recipient')}, ${f.previewState}: ${attachments}; ${body}.`;
    }
    case 'ticket': {
      const f = o.facts;
      return `[screen] Ticket ${f.ticketId} (${f.status}) for order ${show(f.orderId, 'unknown')}: ${show(f.summary, 'no summary yet')}`;
    }
    case 'input_activity':
      return null;
  }
}

/** A short, human line for the observation list. */
export function summarizeObservation(o: ScreenObservation): string {
  if (isScreenActivity(o as { kind: string })) return screenActivitySummary((o as unknown as ScreenActivityObservation).facts);
  switch (o.kind) {
    case 'order_view': return `Order ${show(o.facts.orderId, '?')} · ${show(o.facts.customerRef, 'unknown customer')}`;
    case 'email_draft': return `Email to ${show(o.facts.recipientRef, 'unknown')} · ${o.facts.previewState} · ${o.facts.attachments.length} attachment(s)`;
    case 'ticket': return `Ticket ${o.facts.ticketId} · ${o.facts.status}`;
    case 'input_activity': return `Input on ${o.facts.surface}: ${o.facts.typing ? 'typing' : `idle ${Math.round(o.facts.idleMs / 100) / 10} s`}`;
  }
}
