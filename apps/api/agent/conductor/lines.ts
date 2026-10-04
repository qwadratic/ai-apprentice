// What Clipa says when she guides someone from one step to the next. Short, in English: when a line is spoken it goes
// through the voice agent as [ASK], and the agent says it in the language of the conversation.
// The web app is where the whole journey happens; the macOS app is a lighter face that hands over to the web for
// Review and the summary, so it has fewer lines.
import type { ClientKind, Mode, Persona, Target } from './protocol.ts';

export interface GuideLine { step: string; phase: Mode | 'share' | 'summary'; text: string; target: Target | null; speak: boolean }

const ui = (name: 'share' | 'start' | 'mode_tab' | 'board_gap' | 'teachback' | 'summary', mode?: Mode): Target =>
  mode ? { kind: 'ui', name, mode } : { kind: 'ui', name };

type Lines = Readonly<Record<string, GuideLine>>;

const WEB_EXPERT: Lines = {
  welcome: { step: 'welcome', phase: 'learn', text: 'Press Start in Show, then share your whole screen and work as usual.', target: ui('start', 'learn'), speak: false },
  share_now: { step: 'share_now', phase: 'share', text: 'Now share your whole screen so I can see your work.', target: ui('share'), speak: false },
  share_failed: { step: 'share_failed', phase: 'share', text: 'Sharing did not start. Try again and pick the entire screen.', target: ui('share'), speak: false },
  start_learn: { step: 'start_learn', phase: 'learn', text: 'I can see your screen. Press Start in Show and just work.', target: ui('start', 'learn'), speak: false },
  work: { step: 'work', phase: 'learn', text: 'I am watching quietly and will only ask at natural pauses.', target: null, speak: false },
  review: { step: 'review', phase: 'review', text: 'Thanks. Let us look at what I learned: open Reflect.', target: ui('mode_tab', 'review'), speak: true },
  building: { step: 'building', phase: 'review', text: 'I am putting your steps and rules on the map.', target: null, speak: false },
  no_session_yet: { step: 'no_session_yet', phase: 'review', text: 'There is nothing on the map yet. Run Show first.', target: ui('mode_tab', 'learn'), speak: true },
  gaps: { step: 'gaps', phase: 'review', text: 'A few points are still open. I will ask about them one at a time.', target: ui('board_gap'), speak: false },
  teachback: { step: 'teachback', phase: 'review', text: 'Here is what I understood. Tell me if it is right or what to change.', target: ui('teachback'), speak: false },
  talk_to_edit: { step: 'talk_to_edit', phase: 'review', text: 'Just tell me what to change, add or remove; I will edit the map.', target: null, speak: false },
  handoff: { step: 'handoff', phase: 'teach', text: 'The map is confirmed. A new hire can start Pass it on now.', target: ui('mode_tab', 'teach'), speak: true },
};
const WEB_NEW_HIRE: Lines = {
  welcome: { step: 'welcome', phase: 'teach', text: 'Press Start in Pass it on, then share your screen. I will help you decide like the expert.', target: ui('start', 'teach'), speak: false },
  share_now: { step: 'share_now', phase: 'share', text: 'Now share your screen so I can follow your case.', target: ui('share'), speak: false },
  share_failed: { step: 'share_failed', phase: 'share', text: 'Sharing did not start. Try again and pick the entire screen.', target: ui('share'), speak: false },
  start_teach: { step: 'start_teach', phase: 'teach', text: 'I can see your screen. Press Start in Pass it on and work on your case.', target: ui('start', 'teach'), speak: false },
  no_map: { step: 'no_map', phase: 'teach', text: 'There is no confirmed map yet: the expert confirms one in Reflect first.', target: null, speak: true },
  work: { step: 'work', phase: 'teach', text: 'Go ahead. Tell me what you would do next and why.', target: null, speak: false },
  summary: { step: 'summary', phase: 'summary', text: 'Well done. Here is what you handled and what to practise.', target: ui('summary'), speak: true },
};
const MAC_EXPERT: Lines = {
  welcome: { step: 'welcome', phase: 'learn', text: 'I am here in the corner. Work as usual; I will only ask at natural pauses.', target: null, speak: false },
  work: { step: 'work', phase: 'learn', text: 'Watching quietly.', target: null, speak: false },
};
const MAC_NEW_HIRE: Lines = {
  welcome: { step: 'welcome', phase: 'teach', text: 'I am here in the corner. Start your case; I will speak up before a risky step.', target: null, speak: false },
  no_map: { step: 'no_map', phase: 'teach', text: 'There is no confirmed map yet: the expert confirms one in Reflect first.', target: null, speak: true },
  work: { step: 'work', phase: 'teach', text: 'Go ahead. Tell me what you would do next and why.', target: null, speak: false },
};

export const GUIDE: Readonly<Record<ClientKind, Readonly<Record<Persona, Lines>>>> = {
  web: { expert: WEB_EXPERT, new_hire: WEB_NEW_HIRE },
  macos: { expert: MAC_EXPERT, new_hire: MAC_NEW_HIRE },
};

/** macOS hands over to the web for these pages: what Clipa says when she asks to open it. */
export const OPEN_WEB: Readonly<Record<'review' | 'teach' | 'summary', string>> = {
  review: 'Let us look at what I learned. I am opening the map in your browser; just talk to me there.',
  teach: 'Your practice case continues in the browser.',
  summary: 'Nice work. Your summary is in the browser.',
};

/** The language of the person's latest turns, as a short code, or null when it looks like English or is unclear. */
export function detectLanguage(turns: readonly string[]): string | null {
  const text = turns.slice(-2).join(' ');
  if (text.trim().length < 4) return null;
  const letters = text.replace(/[^\p{L}]/gu, '');
  if (letters.length === 0) return null;
  const cyrillic = (letters.match(/\p{Script=Cyrillic}/gu) ?? []).length;
  if (cyrillic / letters.length > 0.4) return /[іїєґ]/i.test(text) ? 'uk' : 'ru';
  const lower = ` ${text.toLowerCase()} `;
  if (/[äöüß]/.test(lower) || /\s(und|nicht|ich|das|ist|weil|wir|mit|für)\s/.test(lower)) return 'de';
  if (/[ñ¿¡]/.test(lower) || /\s(porque|para|pero|esto|tengo)\s/.test(lower)) return 'es';
  if (/[àâçèêëîïôœùûÿ]/.test(lower) || /\s(parce|pour|avec|c'est|je|nous)\s/.test(lower)) return 'fr';
  return null;
}

/** Show and Pass it on: what Clipa says when nobody has talked or typed for a while, in turn (RULES.nudges). */
export const NUDGES: readonly string[] = [
  "Tell me what you're doing as you go.",
  'What are you looking at right now?',
  'Talk me through this step.',
  'What comes next, and why?',
];

/** The short confirmation when the person picks a stage by voice; the web opens that stage the way a click on it does. */
export const STAGE_CONFIRM: Readonly<Record<Mode, string>> = {
  learn: 'Okay, here is Show. Press Start when you are ready.',
  review: 'Okay, here is Reflect. Press Start when you are ready.',
  teach: 'Okay, here is Pass it on. Press Start when you are ready.',
};

// Explicit phrases only (EN, RU, DE). A phrase counts as whole words, in any case, and only near the start of the turn,
// so that a sentence which merely contains it ("my boss used to teach me this") does not switch the stage.
const STAGE_PHRASES: ReadonlyArray<readonly [Mode, readonly string[]]> = [
  ['learn', ['let me show you', "i'll show you", 'i will show you', 'покажу', 'zeig dir', 'zeige dir']],
  ['review', ["let's review", 'let us review', 'lets review', 'давай проверим', 'lass uns prüfen']],
  ['teach', ['teach me', 'научи', 'bring es mir bei']],
];
/** The phrase has to begin within the first few words of the turn. */
const STAGE_LEAD_WORDS = 3;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// \b does not count Cyrillic letters or umlauts as word characters, so the boundaries are spelled out with \p{L}.
const STAGE_RES: ReadonlyArray<readonly [Mode, RegExp]> = STAGE_PHRASES.map(([mode, phrases]) => [
  mode,
  new RegExp(`(?<![\\p{L}\\p{N}'])(?:${phrases.map((p) => escapeRe(p).replace(/ /g, '\\s+')).join('|')})(?![\\p{L}\\p{N}])`, 'iu'),
]);

/** The stage a final turn of the person explicitly asks for, or null. */
export function stageAsked(text: string): Mode | null {
  const turn = text.replace(/[‘’]/g, "'");
  let best: { mode: Mode; at: number } | null = null;
  for (const [mode, re] of STAGE_RES) {
    const m = re.exec(turn);
    if (!m) continue;
    const lead = turn.slice(0, m.index).match(/[\p{L}\p{N}']+/gu)?.length ?? 0;
    if (lead > STAGE_LEAD_WORDS) continue;
    if (best === null || m.index < best.at) best = { mode, at: m.index };
  }
  return best?.mode ?? null;
}
