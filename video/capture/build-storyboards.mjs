// Builds scripts/demo.json, and sets the clip times in scripts/tech.json, from a journey recording:
// assets/recordings/journey.json (markers, seconds on the mp4) and journey.cues.json (what Clipa said, live).
//
//   node capture/build-storyboards.mjs
//
// Every Clipa line quoted on screen is taken from journey.cues.json, so the captions match the recording.
import { readFileSync, writeFileSync } from 'node:fs';

const rec = JSON.parse(readFileSync('assets/recordings/journey.json', 'utf8'));
const cues = JSON.parse(readFileSync('assets/recordings/journey.cues.json', 'utf8'));
const tour = JSON.parse(readFileSync('assets/recordings/ui-tour.json', 'utf8'));
const m = Object.fromEntries(rec.markers.map((x) => [x.marker, x.tSec]));
const has = (name) => typeof m[name] === 'number';
const SRC = 'recordings/journey.mp4';
const BADGE = 'Simulated input: screen events and answers posted as text · synthetic data';

/** A clip scene that shows [from, to] of the journey in about `target` seconds (sped up when the stretch is longer). */
const clip = (from, to, target, heading, captions, extra = {}) => {
  const span = Math.max(0.5, to - from);
  const rate = Math.max(1, Number((span / target).toFixed(2)));
  const durationSec = Number((span / rate).toFixed(2));
  return { type: 'clip', durationSec, src: SRC, startFromSec: Number(from.toFixed(2)), playbackRate: rate, layout: 'framed', heading, badge: BADGE, captions: captions(durationSec), ...extra };
};

/** Like clip(), but each caption starts at a moment of the recording: lines = [[sourceSec, text], ...]. */
const timedClip = (from, to, target, heading, lines, extra = {}) => {
  const span = Math.max(0.5, to - from);
  const rate = Math.max(1, Number((span / target).toFixed(2)));
  const durationSec = Number((span / rate).toFixed(2));
  const starts = lines.map(([sec]) => Math.max(0.3, (sec - from) / rate));
  const captions = lines.map(([, text], i) => ({
    fromSec: Number(starts[i].toFixed(2)),
    toSec: Number((i + 1 < lines.length ? starts[i + 1] - 0.15 : durationSec - 0.2).toFixed(2)),
    text,
  })).filter((c) => c.toSec - c.fromSec > 0.8);
  return { type: 'clip', durationSec, src: SRC, startFromSec: Number(from.toFixed(2)), playbackRate: rate, layout: 'framed', heading, badge: BADGE, captions, ...extra };
};

/** Splits a scene's time evenly between caption lines. */
const spread = (lines) => (d) => {
  const step = d / lines.length;
  return lines.map((text, i) => ({ fromSec: Number((i * step + 0.25).toFixed(2)), toSec: Number(((i + 1) * step - 0.15).toFixed(2)), text }));
};

const firstCue = (type, fromSec, toSec = Infinity, mode = null) =>
  cues.find((c) => c.type === type && c.tSec >= fromSec && c.tSec <= toSec && (mode === null || c.mode === mode));
const clean = (t, n = 150) => (t ?? '').replace(/\s+/g, ' ').trim().slice(0, n);


// The same choice of spoken answer as recorder/journey.ts, so a caption quotes exactly what the recorder posted.
const expertAnswer = (question) => {
  const q = (question ?? '').toLowerCase();
  if (/(unknown|not sure|unsure|can't tell|cannot tell|stop|ask someone|check with)/.test(q)) return 'If I cannot tell which customer it is, I ask the account owner before sending. I never guess.';
  if (/(other customer|every|all customers|only|always|apply|anyone else)/.test(q)) return 'Only customer_07. They asked to get it as text. Everyone else gets the usual template image.';
  if (/\bwhy\b/.test(q)) return 'Because customer_07 asked us to send the delivery address and time as text in the email. Only for them; an extra image is fine.';
  if (/(remove|image|attach|picture|screenshot)/.test(q)) return 'I would not remove it. The image can stay as an extra; what matters is that the address and the delivery time are written in the email text.';
  return 'Because customer_07 asked us to send the delivery address and time as text in the email. Only for them; an extra image is fine.';
};

const quoteAnswer = (question) => {
  const answer = expertAnswer(question);
  if (answer.startsWith('I would not remove it. ') && !/remove/i.test(question ?? '')) return `… ${answer.slice('I would not remove it. '.length)}`;
  return answer;
};

const ask1 = firstCue('ask', m['show-change'] ?? 0, m['show-end'] ?? Infinity);
const ask2 = has('show-ask2') ? firstCue('ask', m['show-change2'], m['show-end'] ?? Infinity) : null;
const gap = has('reflect-ask-0') ? firstCue('ask', m.reflect) : null;
const teachback = firstCue('teachback', m.reflect ?? 0);
const warn = has('teach-warn') ? firstCue('warn', m['teach-send']) : null;

const scenes = [];
scenes.push({
  type: 'title', durationSec: 6, kicker: 'The problem', title: 'Years of judgment, written down nowhere',
  subtitle: 'A screen recording shows what the expert did. Never why.',
  footer: 'Hack-Nation 7 · Challenge 01 · All data in this video is synthetic', showClipa: false,
});
scenes.push({
  type: 'clipa-intro', durationSec: 6, greeting: "Hi, I'm Clipa.",
  line: 'I watch an expert work, ask why at the pauses, and coach the next person.', footer: 'Your teal paperclip apprentice',
});
const tm = Object.fromEntries(tour.markers.map((x) => [x.marker, x.tSec]));
scenes.push({
  type: 'clip', durationSec: 8, src: 'recordings/ui-tour.mp4', startFromSec: Math.max(0, (tm.rail ?? 3.7) - 0.4), playbackRate: 1.5, layout: 'framed',
  heading: 'The live web app', badge: 'Recording of qwadratic.github.io/clipa',
  captions: [
    { fromSec: 0.3, toSec: 4.2, text: 'Three stages on one rail: Show → Reflect → Pass it on.' },
    { fromSec: 4.4, toSec: 7.8, text: 'Clipa, the teal paperclip, guides each one.' },
  ],
  highlights: [{ fromSec: 0.3, toSec: 3.6, x: 0.22, y: 0.0, w: 0.38, h: 0.11, label: 'The rail' }],
});

// 1 · Show
scenes.push(clip(m.show - 0.3, m['show-change'] + 0.5, 11, '1 · Show', spread([
  '1 · Show: the expert works through the task in the demo workspace.',
  'Clipa stays quiet while the expert types.',
])));
if (ask1) {
  const from = m['show-change'] - 0.5;
  scenes.push(timedClip(from, m['show-answer'] + 8, 15, '1 · Show', [
    [from, 'The typing stops. Clipa waits for a natural pause.'],
    [m['show-ask'], `Clipa, at the pause: “${clean(ask1.text, 180)}”`],
    [m['show-answer'], `Expert: “${quoteAnswer(ask1.text)}”`],
  ]));
}
if (ask2) {
  scenes.push(clip(m['show-change2'], m['show-answer2'] + 2.5, 8, '1 · Show', spread([
    'A second question, about the attached image.',
  ])));
}

// 2 · Reflect
const mapAt = m['reflect-map'] ?? m.reflect + 20;
scenes.push(clip(m.reflect - 0.3, mapAt + 7, 12, '2 · Reflect', spread([
  '2 · Reflect: Clipa turns the session into a Work Map.',
  'Steps, judgment calls and guardrails, with each rule in the expert’s words.',
])));
if (has('reflect-ask-0')) {
  scenes.push(clip(m['reflect-ask-0'] - 0.5, m['reflect-answer-0'] + 8, 11, '2 · Reflect', (d) => [
    { fromSec: 0.3, toSec: d * 0.55, text: gap ? `An open point: “${clean(gap.text, 180)}”` : 'An open point the task did not answer.' },
    { fromSec: d * 0.57, toSec: d - 0.2, text: `Expert: “${quoteAnswer(gap?.text)}”` },
  ]));
}
if (has('reflect-teachback')) {
  const from = m['reflect-teachback'] - 0.3;
  const end = has('reflect-correction') ? m['reflect-correction'] + 5 : m['reflect-teachback'] + 10;
  scenes.push(timedClip(from, end, 12, '2 · Reflect', [
    [from, 'The teach-back: Clipa reads back what she understood.'],
    ...(has('reflect-correction') ? [[m['reflect-correction'], 'Expert: “One correction: it is the delivery time window, not only the date.”']] : []),
  ]));
}
if (has('reflect-confirm')) {
  const from = has('reflect-teachback-2') ? m['reflect-teachback-2'] - 0.3 : m['reflect-confirm'] - 1.5;
  const fixed = cues.find((c) => c.type === 'say' && c.mode === 'review' && c.tSec >= from - 1 && c.tSec <= m['reflect-confirm']);
  scenes.push(timedClip(from, m['reflect-confirm'] + 6, 10, '2 · Reflect', [
    ...(fixed ? [[from, `Clipa: “${clean(fixed.text, 160)}”`]] : []),
    [m['reflect-confirm'], 'The expert presses Confirm: the map is confirmed, not written afterwards.'],
  ]));
}

// 3 · Pass it on
if (has('teach')) {
  const warnEnd = has('teach-warn') ? m['teach-warn'] + 8 : m['teach-send'] + 12;
  scenes.push(clip(m.teach - 0.3, m['teach-send'], 8, '3 · Pass it on', spread([
    '3 · Pass it on: a new hire, a new case for customer_07.',
    'The draft only says “see the attached delivery summary”.',
  ])));
  scenes.push(timedClip(m['teach-send'] - 0.5, warnEnd, 14, '3 · Pass it on', [
    [m['teach-send'] - 0.5, 'The new hire moves to Send. Clipa checks the expert’s confirmed rules.'],
    ...(has('teach-warn') ? [[m['teach-warn'], warn ? `Before Send, Clipa steps in: “${clean(warn.text, 180)}”` : 'Before Send, Clipa warns.']] : []),
  ]));
}
if (has('teach-fixed')) {
  scenes.push(clip(m['teach-fixed'] - 6, m['teach-fixed'] + 2, 7, '3 · Pass it on', spread([
    'She warns. She never clicks for you or blocks another app.',
    'The new hire adds the address and time as text.',
  ])));
}
if (has('teach-allow')) {
  scenes.push(clip(m['teach-allow'] - 3, (m['teach-allow-end'] ?? m['teach-allow'] + 20), 9, '3 · Pass it on', spread([
    'customer_03, the same image-only email: the expert’s rule is only for customer_07.',
    'No warning: the rule does not apply here.',
  ])));
}
if (has('off')) {
  scenes.push(clip(m.off - 1.5, Math.min(m.off + 4.5, rec.durationSec - 0.2), 6, 'Off the record', spread([
    'Off the record stops the screen and the voice at once.',
    'It does not recall what was already sent.',
  ])));
}
scenes.push({
  type: 'clipa-outro', durationSec: 7, headline: "Clipa. The expert's judgment, passed on.",
  lines: ['Clipa learns how your best people decide, teaches it to the next person, and turns it into agents that ask before they break your rules.'],
  links: [{ label: 'Demo', url: 'qwadratic.github.io/clipa' }, { label: 'Code', url: 'github.com/qwadratic/clipa' }],
  note: 'Synthetic data. The expert’s and the new hire’s answers were scripted for this recording. Masks protect the screen, not speech.',
});

const demo = { transitionSec: 0.5, scenes };
writeFileSync('scripts/demo.json', `${JSON.stringify(demo, null, 2)}\n`);
const total = scenes.reduce((s, x) => s + x.durationSec, 0) - 0.5 * (scenes.length - 1);
console.log(`demo.json: ${scenes.length} scenes, ${total.toFixed(1)} s`);
console.log('quoted live lines:', JSON.stringify({ ask1: clean(ask1?.text), ask2: clean(ask2?.text), gap: clean(gap?.text), teachback: clean(teachback?.text, 400), warn: clean(warn?.text, 300) }, null, 2));

// The tech video has its own builder: capture/build-tech.mjs.
