// What the shell says to the voice agent besides the question itself.
import type { ScreenObservation } from '@apprentice/contracts';

const MAX_QUESTION_CHARS = 400;

/**
 * The live agent says what follows [ASK] verbatim and otherwise calls skip_turn. The live model is flash_v2,
 * which would read intonation tags aloud, so no audio tags are added here (they come with a model that
 * understands them).
 */
export function askMessage(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim().replace(/^\[ASK\]\s*/i, '').slice(0, MAX_QUESTION_CHARS);
  return `[ASK] ${clean}`;
}

const show = (value: string | null, fallback: string): string => (value === null || value === '' ? fallback : value);

/** One neutral sentence per observation, for sendContextualUpdate. Heartbeats are not sent (they would flood the agent). */
export function observationToContext(o: ScreenObservation): string | null {
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
  switch (o.kind) {
    case 'order_view': return `Order ${show(o.facts.orderId, '?')} · ${show(o.facts.customerRef, 'unknown customer')}`;
    case 'email_draft': return `Email to ${show(o.facts.recipientRef, 'unknown')} · ${o.facts.previewState} · ${o.facts.attachments.length} attachment(s)`;
    case 'ticket': return `Ticket ${o.facts.ticketId} · ${o.facts.status}`;
    case 'input_activity': return `Input on ${o.facts.surface}: ${o.facts.typing ? 'typing' : `idle ${Math.round(o.facts.idleMs / 100) / 10} s`}`;
  }
}
