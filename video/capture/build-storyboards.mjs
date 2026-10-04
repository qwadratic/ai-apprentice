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

/** Splits a scene's time evenly between caption lines. */
const spread = (lines) => (d) => {
  const step = d / lines.length;
  return lines.map((text, i) => ({ fromSec: Number((i * step + 0.25).toFixed(2)), toSec: Number(((i + 1) * step - 0.15).toFixed(2)), text }));
};

const firstCue = (type, fromSec, toSec = Infinity, mode = null) =>
  cues.find((c) => c.type === type && c.tSec >= fromSec && c.tSec <= toSec && (mode === null || c.mode === mode));
const clean = (t, n = 150) => (t ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

const ask1 = firstCue('ask', m['show-change'] ?? 0, m['show-end'] ?? Infinity);
const ask2 = has('show-ask2') ? firstCue('ask', m['show-change2'], m['show-end'] ?? Infinity) : null;
const gap = has('reflect-ask-0') ? firstCue('ask', m['reflect-map'] ?? m.reflect) : null;
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
  line: 'I watch an expert work, ask why at the pauses, and coach the next person.', footer: 'A teal paperclip apprentice. Not an office assistant.',
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
  '1 · Show: the expert does a real task and talks as she works.',
  'Clipa stays quiet while she types.',
])));
if (ask1) {
  scenes.push(clip(m['show-change'] + 0.5, m['show-answer'] + 3.5, 12, '1 · Show', (d) => [
    { fromSec: 0.3, toSec: d * 0.55, text: 'At the pause, Clipa asks why, about what changed on screen.' },
    { fromSec: d * 0.58, toSec: d - 0.2, text: 'Expert: “customer_07 asked for it as text. Only for them.”' },
  ], { zoom: [{ fromSec: 0.8, toSec: 99, x: 0.2, y: 0.05, scale: 1.45 }] }));
}
if (ask2) {
  scenes.push(clip(m['show-change2'], m['show-answer2'] + 2.5, 8, '1 · Show', spread([
    'A second question, about the attached image.',
  ]), { zoom: [{ fromSec: 0.5, toSec: 99, x: 0.2, y: 0.05, scale: 1.45 }] }));
}

// 2 · Reflect
const mapAt = m['reflect-map'] ?? m.reflect + 20;
scenes.push(clip(m.reflect - 0.3, mapAt + 7, 12, '2 · Reflect', spread([
  '2 · Reflect: Clipa turns the session into a Work Map.',
  'Steps with their screen moments; rules in the expert’s own words.',
]), { zoom: [{ fromSec: 6.5, toSec: 99, x: 0.3, y: 0.35, scale: 1.3 }] }));
if (has('reflect-ask-0')) {
  scenes.push(clip(m['reflect-ask-0'] - 0.5, m['reflect-answer-0'] + 3, 9, '2 · Reflect', spread([
    'An open point the task did not answer. The expert replies.',
  ])));
}
if (has('reflect-teachback')) {
  const end = has('reflect-correction') ? m['reflect-correction'] + 5 : m['reflect-teachback'] + 10;
  scenes.push(clip(m['reflect-teachback'] - 0.3, end, 12, '2 · Reflect', spread([
    'The teach-back: Clipa reads back what she understood.',
    'Expert: “One correction: the delivery time window, not only the date.”',
  ])));
}
if (has('reflect-confirm')) {
  scenes.push(clip(m['reflect-confirm'] - 1.5, m['reflect-confirm'] + 6, 7, '2 · Reflect', spread([
    'Confirmed by the expert, not written afterwards.',
  ])));
}

// 3 · Pass it on
if (has('teach')) {
  const warnEnd = has('teach-warn') ? m['teach-warn'] + 8 : m['teach-send'] + 12;
  scenes.push(clip(m.teach - 0.3, m['teach-send'], 8, '3 · Pass it on', spread([
    '3 · Pass it on: a new hire, a new case for customer_07.',
    'The draft has only the image. The new hire moves to Send.',
  ])));
  scenes.push(clip(m['teach-send'], warnEnd, 12, '3 · Pass it on', spread([
    'Before Send, Clipa warns, with the expert’s reason.',
    'She warns. She never clicks for you or blocks another app.',
  ]), { zoom: [{ fromSec: 1.5, toSec: 99, x: 0.95, y: 0.6, scale: 1.4 }] }));
}
if (has('teach-fixed')) {
  scenes.push(clip(m['teach-fixed'] - 5, m['teach-fixed'] + 2, 6, '3 · Pass it on', spread(['The new hire adds the address and time as text.'])));
}
if (has('teach-allow')) {
  scenes.push(clip(m['teach-allow'] - 3, (m['teach-allow-end'] ?? m['teach-allow'] + 20), 9, '3 · Pass it on', spread([
    'Another customer, the same image-only email: the rule does not apply.',
    'Clipa stays quiet.',
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
  lines: ['Show. Reflect. Pass it on.'],
  links: [{ label: 'Demo', url: 'qwadratic.github.io/clipa' }, { label: 'Code', url: 'github.com/qwadratic/clipa' }],
  note: 'Synthetic data; a teammate wrote the expert’s answers. Masks protect the screen, not speech.',
});

const demo = { transitionSec: 0.5, scenes };
writeFileSync('scripts/demo.json', `${JSON.stringify(demo, null, 2)}\n`);
const total = scenes.reduce((s, x) => s + x.durationSec, 0) - 0.5 * (scenes.length - 1);
console.log(`demo.json: ${scenes.length} scenes, ${total.toFixed(1)} s`);
console.log('quoted live lines:', JSON.stringify({ ask1: clean(ask1?.text), ask2: clean(ask2?.text), gap: clean(gap?.text), teachback: clean(teachback?.text, 400), warn: clean(warn?.text, 300) }, null, 2));

// The tech video's three product clips.
const tech = JSON.parse(readFileSync('scripts/tech.json', 'utf8'));
const clips = tech.scenes.filter((s) => s.type === 'clip');
if (clips[0]) clips[0].startFromSec = Number(((m['show-typing'] ?? 14) - 1).toFixed(2));
if (clips[1]) clips[1].startFromSec = Number(((m['reflect-map'] ?? m.reflect ?? 90) - 3).toFixed(2));
if (clips[2]) clips[2].startFromSec = Number(((m['teach-send'] ?? 200) - 2).toFixed(2));
writeFileSync('scripts/tech.json', `${JSON.stringify(tech, null, 2)}\n`);
const techTotal = tech.scenes.reduce((s, x) => s + x.durationSec, 0) - 0.5 * (tech.scenes.length - 1);
console.log(`tech.json: ${tech.scenes.length} scenes, ${techTotal.toFixed(1)} s`);
