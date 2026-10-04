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
  earlier_map: { step: 'earlier_map', phase: 'review', text: 'Nothing from this session yet, so here is the map of your last session. Tell me what to change.', target: null, speak: true },
  demo_map: { step: 'demo_map', phase: 'review', text: 'No session yet, so here is a demo map with synthetic data. Talk it through with me, or run Show first.', target: null, speak: true },
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

// ---- voice control and the flow between stages ----------------------------------------------------------------------
// Short final turns only, so that a sentence which merely contains a word ("I've done the terms for Lumen") never ends a
// stage or the session. Turns are compared as lower-case words, with curly quotes and ё made plain.

/** The stage names the person sees. */
export const STAGE_NAMES: Readonly<Record<Mode, string>> = { learn: 'Show', review: 'Reflect', teach: 'Pass it on' };
/** What the voice agent hears (never spoken) when a stage starts, so it always knows where the journey is. */
export const STAGE_ABOUT: Readonly<Record<Mode, string>> = {
  learn: 'the expert works on screen; ask only at natural pauses.',
  review: 'the expert checks the map.',
  teach: 'a new hire works on a new case; step in before one of the expert\'s rules is broken.',
};
/** The short line before Clipa starts a stage herself (the person asked for it, said they are done, or said yes). */
export const STAGE_START: Readonly<Record<Mode, string>> = {
  learn: "Okay, let's start Show.",
  review: "Okay, let's reflect.",
  teach: "Okay, let's pass it on.",
};
/** Auto mode: Show looks finished (a long quiet after real work), and Clipa moves on by herself. */
export const SHOW_LOOKS_DONE = "Looks like that's it. Let's reflect.";
/** Manual mode: at the same moments Clipa only proposes the next stage; a "yes" or a click starts it. */
export const PROPOSE: Readonly<Record<'review' | 'teach', string>> = {
  review: 'Shall we reflect? Say yes, or press Reflect.',
  teach: 'Shall we pass it on? Say yes, or press Pass it on.',
};
/** macOS: the person said they are done with Show; the hand-over to Reflect in the browser follows when the Mac ends Show. */
export const MAC_DONE_LINE = "Got it. End Show, and I'll open Reflect in the browser.";
/** Said before Clipa ends the session because the person asked her to stop. */
export const OFF_LINE = "Okay, I'm off. Press Start when you need me.";
/** Pass it on: the rule Clipa warned about is kept now (the check comes back clear). Said once; it names no rule. */
export const RESOLVED = 'That fixes it. Ready for review.';

const plainText = (text: string): string => text.toLowerCase().replace(/[‘’`´]/g, "'").replace(/ё/g, 'е');
const words = (text: string): Array<{ w: string; start: number; end: number }> =>
  [...plainText(text).matchAll(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu)].map((m) => ({ w: m[0], start: m.index, end: m.index + m[0].length }));
const phrases = (list: readonly string[]): string[][] => list.map((p) => words(p).map((x) => x.w));
/** Where `phrase` starts in `ws` at or after `from`, or -1. */
function find(ws: readonly string[], phrase: readonly string[], from = 0): number {
  for (let i = from; i + phrase.length <= ws.length; i++) if (phrase.every((p, k) => ws[i + k] === p)) return i;
  return -1;
}

const DONE_PHRASES = phrases([
  "that's it", 'that is it', "i'm done", 'i am done', "we're done", 'we are done', 'done', 'all done', 'finished',
  "i'm finished", 'i am finished', "that's all",
  'готово', 'это всё', 'вот и всё', 'ну всё', 'закончил', 'закончила', 'я закончил', 'я закончила',
  'fertig', 'ich bin fertig', "das war's", 'das wars', 'das ist alles',
]);
/** Words that may come right before a done phrase ("okay so that's it", "I think I'm done"). */
const DONE_LEAD = new Set(['ok', 'okay', 'so', 'and', 'well', 'alright', 'think', 'guess', 'then', 'now', 'ну', 'так', 'ладно', 'и', 'вот', 'кажется', 'думаю', 'also', 'und', 'dann', 'glaube', 'denke']);
/** A done phrase right after one of these is an answer ("Yes, that's it.", "Exactly, that's all."), not the end of a stage. */
const AFFIRM = new Set(['yes', 'yeah', 'yep', 'right', 'exactly', 'correct', 'true', 'sure', 'да', 'точно', 'верно', 'именно', 'ja', 'genau', 'richtig', 'stimmt', 'gut']);
/** Words that may follow a done phrase in a turn of at most five words ("that's it for now", "готово, спасибо"). */
const DONE_TAIL = new Set(['now', 'then', 'here', 'for', 'today', 'thanks', 'thank', 'you', 'guys', 'ok', 'okay', 'сейчас', 'спасибо', 'на', 'сегодня', 'jetzt', 'danke', 'für', 'heute']);
const DONE_SHORT_WORDS = 5;
const DONE_END_WORDS = 8;

/**
 * The person says they are done with this stage: a done phrase in a short final turn. The whole turn has at most five words
 * (anything after the phrase is a filler such as "for now"), or the phrase ends a turn of at most eight words. The phrase
 * starts the turn, follows a comma or a full stop, or follows a lead-in word ("so", "I think"). A bare "всё" counts only as
 * the whole turn (with "вот", "ну", "и").
 */
export function doneSaid(text: string): boolean {
  const ws = words(text);
  if (ws.length === 0 || ws.length > DONE_END_WORDS || /\?\s*$/.test(text)) return false;
  const list = ws.map((x) => x.w);
  if (list.at(-1) === 'все' && list.length <= 4 && list.slice(0, -1).every((w) => w === 'вот' || w === 'ну' || w === 'и')) return true;
  const plain = plainText(text);
  for (const phrase of DONE_PHRASES) {
    for (let i = find(list, phrase); i >= 0; i = find(list, phrase, i + 1)) {
      const before = i === 0 || (!AFFIRM.has(list[i - 1]!) && (/[,.!?;:—–-]/.test(plain.slice(ws[i - 1]!.end, ws[i]!.start)) || DONE_LEAD.has(list[i - 1]!)));
      if (!before) continue;
      const rest = list.slice(i + phrase.length);
      if (rest.length === 0) return true;
      if (list.length <= DONE_SHORT_WORDS && rest.every((w) => DONE_TAIL.has(w))) return true;
    }
  }
  return false;
}

/** The whole turn is a done phrase and nothing else ("That's it.", "Готово."): it counts even right after a question of Clipa's. */
export function donePhraseOnly(text: string): boolean {
  if (/\?\s*$/.test(text)) return false;
  const list = words(text).map((x) => x.w);
  if (list.length === 1 && list[0] === 'все') return true;
  return DONE_PHRASES.some((p) => p.length === list.length && p.every((w, k) => list[k] === w));
}

/** Words that may stand beside a short command ("okay, stop please", "да, давай"). */
const POLITE = new Set(['ok', 'okay', 'please', 'clipa', 'now', 'thanks', 'thank', 'you', 'hey', 'пожалуйста', 'спасибо', 'ну', 'клипа', 'bitte', 'danke', 'jetzt']);
const SHORT_COMMAND_WORDS = 4;
/** A whole short turn (at most four words) made of these phrases and polite words only, with at least one whole phrase. */
function command(text: string, list: readonly string[][]): boolean {
  const ws = words(text).map((x) => x.w);
  if (ws.length === 0 || ws.length > SHORT_COMMAND_WORDS) return false;
  const allowed = new Set(list.flat());
  return ws.every((w) => allowed.has(w) || POLITE.has(w)) && list.some((p) => find(ws, p) >= 0);
}
const OFF_PHRASES = phrases(['stop', 'stop listening', 'turn off', 'switch off', 'goodbye', 'bye', 'стоп', 'хватит', 'выключись', 'выключайся', 'отключись', 'пока', 'tschüss', 'hör auf']);
const YES_PHRASES = phrases(['yes', 'yeah', 'sure', 'ok', 'okay', "let's go", 'go ahead', 'да', 'давай', 'ага', 'ок', 'поехали', 'ja', 'los', 'gerne']);

/** The person asks Clipa to switch off: a whole short turn ("stop", "goodbye", "выключись", "hör auf"). */
export function offSaid(text: string): boolean { return command(text, OFF_PHRASES); }
/** The person says yes to what Clipa proposed: a whole short turn ("yes", "let's go", "давай", "gerne"). */
export function yesSaid(text: string): boolean { return command(text, YES_PHRASES); }

/** Words that may stand around a stage phrase in a short command ("okay, let's review now", "ну, научи меня"). */
const STAGE_NEUTRAL = new Set([...POLITE, 'so', 'then', 'well', 'alright', 'and', 'так', 'ладно', 'меня', 'also', 'dann', 'und']);
const STAGE_COMMAND_WORDS = 6;
const STAGE_WORDS: ReadonlyArray<readonly [Mode, string[][]]> = STAGE_PHRASES.map(([mode, list]) => [mode, phrases(list)]);
/**
 * The stage a whole short command turn asks for ("Let's review.", "Okay, teach me", "Давай проверим"), or null. While a
 * session runs only such a turn starts a stage: a sentence that merely begins with the phrase ("Let me show you: only
 * customer_07 wants it as text", "Давай проверим адрес доставки") is an ordinary turn.
 */
export function stageCommand(text: string): Mode | null {
  if (/\?\s*$/.test(text)) return null;
  const ws = words(text).map((x) => x.w);
  if (ws.length === 0 || ws.length > STAGE_COMMAND_WORDS) return null;
  for (const [mode, list] of STAGE_WORDS) {
    for (const p of list) {
      const i = find(ws, p);
      if (i >= 0 && ws.every((w, k) => (k >= i && k < i + p.length) || STAGE_NEUTRAL.has(w))) return mode;
    }
  }
  return null;
}
