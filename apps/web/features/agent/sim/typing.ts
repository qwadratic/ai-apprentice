// Typing like a person: a delay for every key, a longer one after a word, a sentence or a line, and now and then a short
// pause to think. The agent's "quiet while someone types" rule (the workspace reports input activity every 2 s, and the
// policy waits several seconds without input before it asks) must see typing as typing, so no pause inside a text is
// longer than MAX_PAUSE_INSIDE_TYPING_MS. The long, natural pauses are separate steps of the task script.
import { between, jittered } from './clock.ts';
import type { Clock } from './clock.ts';

export interface TypingProfile {
  /** Mean time between two keys. */
  keyMs: number;
  /** Extra random time added to a key, up to this much. */
  jitterMs: number;
  /** After a space. */
  wordPauseMs: number;
  /** After . , ; : ! ? */
  punctuationPauseMs: number;
  /** After a line break. */
  newlinePauseMs: number;
  /** A short pause to think after this many characters (min, max). */
  thinkEveryChars: readonly [number, number];
  /** How long that pause lasts (min, max). */
  thinkMs: readonly [number, number];
}

/** About 55 words a minute with the pauses a person makes while copying details from one window into another. */
export const HUMAN_TYPING: TypingProfile = {
  keyMs: 85,
  jitterMs: 70,
  wordPauseMs: 45,
  punctuationPauseMs: 260,
  newlinePauseMs: 600,
  thinkEveryChars: [30, 60],
  thinkMs: [500, 1300],
};

/** No pause inside a text may reach this, or the agent could take the typist for idle. */
export const MAX_PAUSE_INSIDE_TYPING_MS = 1800;

export interface TypedKey {
  char: string;
  /** Time to wait before this key is pressed. */
  delayMs: number;
}

/** The plan for a text: one key per character with the wait before it. Pure, so tests can check it. */
export function planTyping(text: string, profile: TypingProfile, rng: () => number): TypedKey[] {
  const keys: TypedKey[] = [];
  let untilThink = Math.round(between(rng, profile.thinkEveryChars[0], profile.thinkEveryChars[1]));
  let previous = '';
  for (const char of text) {
    let delay = profile.keyMs + rng() * profile.jitterMs;
    if (previous === ' ') delay += profile.wordPauseMs;
    else if (previous === '\n') delay += profile.newlinePauseMs;
    else if (/[.,;:!?]/.test(previous)) delay += profile.punctuationPauseMs;
    untilThink -= 1;
    if (untilThink <= 0 && char !== '\n') {
      delay += between(rng, profile.thinkMs[0], profile.thinkMs[1]);
      untilThink = Math.round(between(rng, profile.thinkEveryChars[0], profile.thinkEveryChars[1]));
    }
    keys.push({ char, delayMs: Math.round(Math.min(delay, MAX_PAUSE_INSIDE_TYPING_MS)) });
    previous = char;
  }
  return keys;
}

/** Types a text: waits the planned delay, then presses the key (`press` appends one character and fires the input event). */
export async function typeLikeAHuman(
  text: string,
  press: (char: string) => void,
  clock: Clock,
  rng: () => number,
  profile: TypingProfile = HUMAN_TYPING,
): Promise<void> {
  for (const key of planTyping(text, profile, rng)) {
    await clock.sleep(key.delayMs);
    press(key.char);
  }
}

/** A short reaction time before a click or a first key: a person does not act the instant they decide to. */
export const reactionMs = (rng: () => number, baseMs = 350): number => jittered(rng, baseMs, 0.4);
