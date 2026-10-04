// Synthetic personas for the simulation (TASK-3.32): an expert for Learn and Review, a new hire for Teach.
//
// A persona is DATA: a display name that says it is synthetic, a voice, and spoken lines keyed by the topic of the
// agent's question. The persona's knowledge (the customer_07 personal rule) lives only here, as things a person would say.
// It is never put into an agent prompt, a knowledge base or a fixture: the agent has to learn it by asking.
//
// The topics are the ones the brain asks about (packages/agent policy/topics.ts): Learn asks reason, essentials and
// guardrail; Review asks reason, scope, exception, why_stop and duration, then plays the map back (teachback). Teach asks
// the new hire to predict (predict), asks why a stop happened (why_hold) and asks for a summary (explain).
// Every line is rendered to an mp3 clip by scripts/render-clips.ts; the clip id is `<persona>.<line id>`.
//
// All data is synthetic. Nothing here is a real person, a real customer or a real order.

export type PersonaId = 'expert' | 'newHire';

/** The question topics a persona can answer. 'ack' is not a question: the new hire says it after a stop. */
export const PERSONA_TOPICS = [
  'reason',
  'essentials',
  'guardrail',
  'scope',
  'exception',
  'why_stop',
  'duration',
  'ticket_note',
  'teachback',
  'predict',
  'why_hold',
  'explain',
  'ack',
] as const;
export type PersonaTopic = (typeof PERSONA_TOPICS)[number];

export interface PersonaLine {
  /** Unique inside the persona. The clip id is `<persona id>.<line id>`. */
  id: string;
  /** What the persona says. It is also what the text-to-speech renders, so it is written the way it is spoken. */
  text: string;
  /** How long the persona thinks before it starts to speak, in ms, before the human-like jitter. */
  thinkMs: number;
}

export interface PersonaVoice {
  /** ElevenLabs stock voice id (premade voices are free to use). */
  voiceId: string;
  voiceName: string;
}

export interface Persona {
  id: PersonaId;
  /** Shown in the UI. Always says it is synthetic. */
  displayName: string;
  /** The banner label of the simulated desktop. */
  banner: string;
  voice: PersonaVoice;
  lines: readonly PersonaLine[];
  /**
   * Which line answers a topic. Keys are `topic` or `topic@caseKey` (the case wins). A list is read by occurrence:
   * the first time the topic is asked the first line answers, the second time the second one, and the last one repeats.
   */
  answers: Readonly<Record<string, readonly string[]>>;
  /** Plays when no answer is keyed for the topic: an honest "I do not know", never a made-up fact. */
  unsure: string;
}

const line = (id: string, text: string, thinkMs: number): PersonaLine => ({ id, text, thinkMs });

/** Customer zero seven is spoken the way a person says it; the brain maps "customer zero seven" to customer_07. */
export const EXPERT: Persona = {
  id: 'expert',
  displayName: 'Synthetic expert (simulation)',
  banner: 'Simulation — synthetic expert',
  voice: { voiceId: 'pqHfZKP75CvOlQylNhV4', voiceName: 'Bill' },
  lines: [
    line(
      'reason',
      'Customer zero seven asked for it as text, because his phone blocks pictures in our emails. So I write the details out myself.',
      900,
    ),
    line('essentials', 'The delivery address and the delivery window. Those two are what he actually needs.', 700),
    line(
      'guardrail',
      'If I cannot tell which customer an order belongs to, I stop and ask the account manager before I send anything.',
      1000,
    ),
    line('scope', 'Only for him. Everyone else still gets the usual picture.', 800),
    line(
      'exception',
      'Yes, an extra picture is fine, as long as the address and the delivery window are also written out in the text.',
      800,
    ),
    line('why_stop', "Because a wrong match would send one customer's delivery details to somebody else.", 800),
    line('duration', 'Until he tells us otherwise. The account manager hears about any change first.', 700),
    line('ticket_note', 'I note the order number, and that the details went out as text.', 600),
    line(
      'teachback_correct',
      'Almost. One correction: the order number goes into the text as well, not only the address and the window.',
      1200,
    ),
    line('teachback_confirm', "Yes, that's right.", 800),
    line('unsure', "I'm not sure about that one. I would have to think about it.", 900),
  ],
  answers: {
    reason: ['reason'],
    essentials: ['essentials'],
    guardrail: ['guardrail'],
    scope: ['scope'],
    exception: ['exception'],
    why_stop: ['why_stop'],
    duration: ['duration'],
    ticket_note: ['ticket_note'],
    // The first play-back gets one correction, the next one a confirmation (Review ends on a confirmed teach-back).
    teachback: ['teachback_correct', 'teachback_confirm'],
  },
  unsure: 'unsure',
};

/**
 * The new hire knows nothing about the personal rule. Its predictions are the natural, wrong-or-right guesses of
 * someone who has only seen the usual way; the tutor has to teach it. Case keys are the demo workspace's case ids.
 */
export const NEW_HIRE: Persona = {
  id: 'newHire',
  displayName: 'Synthetic new hire (simulation)',
  banner: 'Simulation — synthetic new hire',
  voice: { voiceId: 'bIHbv24MWmeRgasZH58o', voiceName: 'Will' },
  lines: [
    line('predict_t1', 'I would attach the usual delivery picture and send it.', 1200),
    line('predict_t2', 'I would write the address and the delivery window into the message, and add the picture as well.', 900),
    line('predict_t3', 'Nothing special here. The usual picture is enough.', 800),
    line('predict_t4', 'I do not know this customer, so I would ask someone before I send anything.', 900),
    line('predict_usual', 'I would just send it the usual way.', 900),
    line('why_hold', "Hmm, I'm not sure. Maybe this customer wants it in text?", 1300),
    line('ack', 'Okay, that makes sense. I will write the order number, the address and the window into the message.', 900),
    line(
      'explain',
      'For this customer I write the details out as text, because his phone blocks pictures. An extra picture is fine, and if I cannot tell the customer, I ask first.',
      1200,
    ),
    line('unsure', "I'm not sure. Could you explain that again?", 900),
  ],
  answers: {
    'predict@new-image': ['predict_t1'],
    'predict@new-text-image': ['predict_t2'],
    'predict@other': ['predict_t3'],
    'predict@unknown': ['predict_t4'],
    predict: ['predict_usual'],
    why_hold: ['why_hold'],
    ack: ['ack'],
    explain: ['explain'],
  },
  unsure: 'unsure',
};

export const PERSONAS: Readonly<Record<PersonaId, Persona>> = { expert: EXPERT, newHire: NEW_HIRE };
export const PERSONA_IDS_IN_ORDER: readonly PersonaId[] = ['expert', 'newHire'];

/** The id of a clip: `<persona id>.<line id>`. */
export const clipIdOf = (persona: PersonaId, lineId: string): string => `${persona}.${lineId}`;

export function getPersona(id: PersonaId): Persona {
  return PERSONAS[id];
}

/** What a persona says for a question, and which clip plays. `known` is false when the persona falls back to "not sure". */
export interface PickedLine {
  line: PersonaLine;
  clipId: string;
  known: boolean;
}

/**
 * Picks the line that answers `topic` (the case-specific key first). `occurrence` is how many times this topic has been
 * asked already (0 for the first time); a list of lines is read by occurrence and its last line repeats.
 */
export function pickLine(persona: Persona, topic: string, caseKey: string | null, occurrence: number): PickedLine {
  const keys = caseKey ? [`${topic}@${caseKey}`, topic] : [topic];
  for (const key of keys) {
    const ids = persona.answers[key];
    if (ids === undefined || ids.length === 0) continue;
    const id = ids[Math.min(Math.max(0, occurrence), ids.length - 1)];
    const found = persona.lines.find((l) => l.id === id);
    if (found) return { line: found, clipId: clipIdOf(persona.id, found.id), known: true };
  }
  const fallback = persona.lines.find((l) => l.id === persona.unsure);
  if (!fallback) throw new Error(`persona ${persona.id}: the "unsure" line ${persona.unsure} is not defined`);
  return { line: fallback, clipId: clipIdOf(persona.id, fallback.id), known: false };
}

/** A persona is valid when every answer names a defined line, line ids are unique and the unsure line exists. */
export function validatePersona(persona: Persona): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const l of persona.lines) {
    if (ids.has(l.id)) problems.push(`duplicate line id ${l.id}`);
    ids.add(l.id);
    if (l.text.trim().length === 0) problems.push(`empty text in ${l.id}`);
  }
  for (const [key, list] of Object.entries(persona.answers)) {
    for (const id of list) if (!ids.has(id)) problems.push(`answer ${key} names an unknown line ${id}`);
  }
  if (!ids.has(persona.unsure)) problems.push(`unsure line ${persona.unsure} is missing`);
  if (!/synthetic/i.test(persona.displayName)) problems.push('display name must say the persona is synthetic');
  if (!/simulation/i.test(persona.banner)) problems.push('banner must say it is a simulation');
  return problems;
}
