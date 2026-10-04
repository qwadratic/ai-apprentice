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
  welcome: { step: 'welcome', phase: 'share', text: 'Share your whole screen, then start Learn and work as usual.', target: ui('share'), speak: false },
  share_failed: { step: 'share_failed', phase: 'share', text: 'Sharing did not start. Try again and pick the entire screen.', target: ui('share'), speak: false },
  start_learn: { step: 'start_learn', phase: 'learn', text: 'I can see your screen. Press Start in Learn and just work.', target: ui('start', 'learn'), speak: false },
  work: { step: 'work', phase: 'learn', text: 'I am watching quietly and will only ask at natural pauses.', target: null, speak: false },
  review: { step: 'review', phase: 'review', text: 'Thanks. Let us look at what I learned: open Review.', target: ui('mode_tab', 'review'), speak: true },
  building: { step: 'building', phase: 'review', text: 'I am putting your steps and rules on the map.', target: null, speak: false },
  no_session_yet: { step: 'no_session_yet', phase: 'review', text: 'There is nothing on the map yet. Run Learn first.', target: ui('mode_tab', 'learn'), speak: true },
  gaps: { step: 'gaps', phase: 'review', text: 'A few points are still open. I will ask about them one at a time.', target: ui('board_gap'), speak: false },
  teachback: { step: 'teachback', phase: 'review', text: 'Here is what I understood. Tell me if it is right or what to change.', target: ui('teachback'), speak: false },
  talk_to_edit: { step: 'talk_to_edit', phase: 'review', text: 'Just tell me what to change, add or remove; I will edit the map.', target: null, speak: false },
  handoff: { step: 'handoff', phase: 'teach', text: 'The map is confirmed. A new hire can start Teach now.', target: ui('mode_tab', 'teach'), speak: true },
};
const WEB_NEW_HIRE: Lines = {
  welcome: { step: 'welcome', phase: 'share', text: 'Share your screen and start Teach. I will help you decide like the expert.', target: ui('share'), speak: false },
  share_failed: { step: 'share_failed', phase: 'share', text: 'Sharing did not start. Try again and pick the entire screen.', target: ui('share'), speak: false },
  start_teach: { step: 'start_teach', phase: 'teach', text: 'I can see your screen. Press Start in Teach and work on your case.', target: ui('start', 'teach'), speak: false },
  no_map: { step: 'no_map', phase: 'teach', text: 'There is no confirmed map yet: the expert confirms one in Review first.', target: null, speak: true },
  work: { step: 'work', phase: 'teach', text: 'Go ahead. Tell me what you would do next and why.', target: null, speak: false },
  summary: { step: 'summary', phase: 'summary', text: 'Well done. Here is what you handled and what to practise.', target: ui('summary'), speak: true },
};
const MAC_EXPERT: Lines = {
  welcome: { step: 'welcome', phase: 'learn', text: 'I am here in the corner. Work as usual; I will only ask at natural pauses.', target: null, speak: false },
  work: { step: 'work', phase: 'learn', text: 'Watching quietly.', target: null, speak: false },
};
const MAC_NEW_HIRE: Lines = {
  welcome: { step: 'welcome', phase: 'teach', text: 'I am here in the corner. Start your case; I will speak up before a risky step.', target: null, speak: false },
  no_map: { step: 'no_map', phase: 'teach', text: 'There is no confirmed map yet: the expert confirms one in Review first.', target: null, speak: true },
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
