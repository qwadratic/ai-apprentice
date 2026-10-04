import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRng } from '../clock.ts';
import { HUMAN_TYPING, MAX_PAUSE_INSIDE_TYPING_MS, planTyping, typeLikeAHuman } from '../typing.ts';
import { VirtualClock } from './helpers.ts';

const TEXT = 'Hello,\n\nYour delivery is scheduled for 2026-10-12 14:00-16:00.\nDelivery address: 14 Sample Lane, 1010 Exampletown.\n\nKind regards,\nDemo operations';

test('the plan has one key per character, in order, so the typed text equals the text', () => {
  const keys = planTyping(TEXT, HUMAN_TYPING, createRng(1));
  assert.equal(keys.map((k) => k.char).join(''), TEXT);
});

test('the same seed types the same way, another seed does not', () => {
  const a = planTyping(TEXT, HUMAN_TYPING, createRng(5)).map((k) => k.delayMs);
  const b = planTyping(TEXT, HUMAN_TYPING, createRng(5)).map((k) => k.delayMs);
  const c = planTyping(TEXT, HUMAN_TYPING, createRng(6)).map((k) => k.delayMs);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test('no pause inside the text is long enough for the agent to take the typist for idle', () => {
  for (let seed = 1; seed <= 20; seed += 1) {
    const worst = Math.max(...planTyping(TEXT, HUMAN_TYPING, createRng(seed)).map((k) => k.delayMs));
    assert.ok(worst <= MAX_PAUSE_INSIDE_TYPING_MS, `seed ${seed}: ${worst} ms`);
  }
  // The workspace reports "idle" after 2 s without input; the cap stays under that.
  assert.ok(MAX_PAUSE_INSIDE_TYPING_MS < 2000);
});

test('keys are not instant: every delay is at least the base key time', () => {
  for (const key of planTyping(TEXT, HUMAN_TYPING, createRng(3))) assert.ok(key.delayMs >= HUMAN_TYPING.keyMs);
});

test('words, punctuation and lines get longer pauses than letters inside a word', () => {
  const profile = { ...HUMAN_TYPING, jitterMs: 0, thinkEveryChars: [10_000, 10_000] as const };
  const keys = planTyping('ab, cd\nef', profile, createRng(1));
  const delayAfter = (index: number): number => keys[index]?.delayMs ?? 0;
  // keys: a b , ' ' c d \n e f ; the delay belongs to the key that FOLLOWS the character
  assert.equal(delayAfter(1), profile.keyMs, 'b follows a');
  assert.equal(delayAfter(3), profile.keyMs + profile.punctuationPauseMs, 'the space follows a comma');
  assert.equal(delayAfter(4), profile.keyMs + profile.wordPauseMs, 'c follows a space');
  assert.equal(delayAfter(7), profile.keyMs + profile.newlinePauseMs, 'e follows a line break');
});

test('a long text has some thinking pauses', () => {
  const long = TEXT.repeat(3);
  const keys = planTyping(long, HUMAN_TYPING, createRng(2));
  const thinks = keys.filter((k) => k.delayMs >= HUMAN_TYPING.thinkMs[0]);
  assert.ok(thinks.length >= 3, `${thinks.length} thinking pauses`);
});

test('typeLikeAHuman presses every key after its delay, on the clock', async () => {
  const clock = new VirtualClock();
  const typed: string[] = [];
  const planned = planTyping('Hi there', HUMAN_TYPING, createRng(9));
  await clock.run(typeLikeAHuman('Hi there', (c) => typed.push(c), clock, createRng(9)));
  assert.equal(typed.join(''), 'Hi there');
  assert.deepEqual(clock.sleeps, planned.map((k) => k.delayMs));
  assert.equal(clock.now(), planned.reduce((sum, k) => sum + k.delayMs, 0));
});
