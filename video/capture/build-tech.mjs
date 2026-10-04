// Builds the ~60 s tech video (scripts/tech.json) and its voice-over script (scripts/tech-voiceover.json) from a journey
// take: assets/recordings/journey.json (markers) and journey.cues.json (what Clipa said, live).
//
//   node capture/build-tech.mjs
//
// The live cuts come in the product's order (Show asks at the pause; Reflect's Work Map, then Confirm; Pass it on's
// warning before Send, then the fix), framed by a short technical story. Clipa's quoted words are copied from the cues.
import { readFileSync, writeFileSync } from 'node:fs';

const rec = JSON.parse(readFileSync('assets/recordings/journey.json', 'utf8'));
const cues = JSON.parse(readFileSync('assets/recordings/journey.cues.json', 'utf8'));
const prev = JSON.parse(readFileSync('scripts/tech.json', 'utf8'));
const m = Object.fromEntries(rec.markers.map((x) => [x.marker, x.tSec]));
const SRC = 'recordings/journey.mp4';
const BADGE = 'Simulated input: screen events and answers posted as text · synthetic data';
const TRANSITION = 0.5;
const cueAt = (type, from, to, mode) => cues.find((c) => c.type === type && c.tSec >= from && c.tSec <= to && (!mode || c.mode === mode));
const clean = (t) => (t ?? '').replace(/\s+/g, ' ').trim();

const ask = cueAt('ask', m['show-change'], m['show-end'], 'learn');
const warn = cueAt('warn', m['teach-send'], m['teach-fixed'], 'teach');
if (!ask || !warn) throw new Error('the take has no Show question or no warning');

/** A live cut: [from, to] of the take shown in durationSec (sped up), captions at moments of the take. */
const cut = (heading, from, to, durationSec, lines, zoom) => {
  const rate = Number(((to - from) / durationSec).toFixed(3));
  const at = (sec) => Math.max(0.3, (sec - from) / rate);
  const starts = lines.map(([sec]) => at(sec));
  const captions = lines.map(([, text], i) => ({
    fromSec: Number(starts[i].toFixed(2)),
    toSec: Number((i + 1 < lines.length ? starts[i + 1] - 0.15 : durationSec - 0.2).toFixed(2)),
    text,
  }));
  const scene = { type: 'clip', durationSec, src: SRC, startFromSec: Number(from.toFixed(2)), playbackRate: rate, layout: 'framed', heading, badge: BADGE, captions };
  if (zoom) scene.zoom = [{ fromSec: Number(at(zoom.sec).toFixed(2)), toSec: durationSec + 1, x: zoom.x, y: zoom.y, scale: zoom.scale }];
  scene.at = at; // removed before writing
  return scene;
};

// The architecture diagram of the long cut, its build-up compressed into about 8 s.
const arch0 = prev.scenes.find((s) => s.type === 'architecture');
// The long cut's diagram runs 24 s; a re-run on this script's own output keeps the times as they are.
const squeeze = (t) => Number((arch0.durationSec > 12 ? t * 0.38 : t).toFixed(2));
const arch = {
  ...arch0,
  durationSec: 9,
  kicker: 'How Clipa is built',
  groups: arch0.groups.map((g) => ({ ...g, atSec: squeeze(g.atSec) })),
  nodes: arch0.nodes.map((n) => ({ ...n, atSec: squeeze(n.atSec) })),
  edges: arch0.edges.map((e) => ({ ...e, atSec: squeeze(e.atSec) })),
  captions: [
    { fromSec: 0.4, toSec: 4.5, text: 'Two faces, web and macOS, and one server on a VM.' },
    { fromSec: 4.7, toSec: 8.8, text: 'Typed observations in, cues out. Voice: ElevenLabs Agents.' },
  ],
};
const code0 = prev.scenes.find((s) => s.type === 'facts' && s.code)?.code;

const scenes = [
  arch,
  {
    type: 'facts', durationSec: 6.5, kicker: 'ScreenBridge v1 · vision', title: 'One contract for any app',
    items: [
      { text: 'Frames are masked in the browser before upload', atSec: 0.3 },
      { text: 'Vision turns each changed frame into one typed observation', atSec: 1.3 },
      { text: 'Region boxes [x, y, w, h], 0..1, so Clipa can point', atSec: 2.3 },
    ],
    ...(code0 ? { code: { ...code0, atSec: 0.8 } } : {}),
  },
  {
    type: 'facts', durationSec: 6.5, kicker: 'The Conductor', title: 'When Clipa speaks',
    items: [
      { text: 'Never while you type or talk', atSec: 0.3 },
      { text: 'A pause: 1.8 s without typing, talking or a screen change', atSec: 1.2 },
      { text: 'The question is prepared as the screen settles, asked at the pause', atSec: 2.1 },
      { text: 'At least 15 s between questions', atSec: 3.0 },
    ],
  },
  cut('1 · Show · live API', m['show-change'] + 3.7, m['show-answer'] + 5, 10.5, [
    [m['show-change'] + 3.7, 'The expert has changed the email. Clipa waits for the pause.'],
    [ask.tSec, `Clipa: “${clean(ask.text)}”`],
    [m['show-answer'], 'The expert’s answer, posted as text.'],
  ], { sec: ask.tSec + 0.5, x: 1, y: 0.47, scale: 1.45 }),
  cut('2 · Reflect · live API', m['reflect-map'] - 0.5, m['reflect-map'] + 6.7, 6, [
    [m['reflect-map'] - 0.5, 'The Work Map, built when Show ended: steps, a judgment call, a guardrail, an open point.'],
  ], { sec: m['reflect-map'] + 0.8, x: 0, y: 0.62, scale: 1.35 }),
  cut('2 · Reflect · live API', m['reflect-confirm'] - 2.9, m['reflect-confirm'] + 3.6, 5.5, [
    [m['reflect-confirm'] - 2.9, 'The teach-back, after one spoken correction.'],
    [m['reflect-confirm'], 'Confirm: map v3 is confirmed by the expert.'],
  ]),
  cut('3 · Pass it on · live API', m['teach-warn'] - 3.8, m['teach-warn'] + 5.7, 8, [
    [m['teach-warn'] - 3.8, 'A new case. The new hire moves to Send.'],
    [warn.tSec, `Clipa: “${clean(warn.text)}”`],
  ], { sec: warn.tSec + 0.5, x: 1, y: 0.42, scale: 1.45 }),
  cut('3 · Pass it on · live API', m['teach-fixed'] - 8, m['teach-fixed'] + 1, 5.5, [
    [m['teach-fixed'] - 8, 'The new hire adds the address and time as text.'],
    [m['teach-fixed'] - 3, 'Clipa warns. She never clicks or blocks another app.'],
  ]),
  {
    type: 'facts', durationSec: 6, kicker: 'Honest limits', title: 'What this is, and is not',
    items: [
      { text: 'Synthetic data; in these cuts, screen events and answers were posted as text', atSec: 0.3 },
      { text: 'Masks protect the screen, not speech; Off the record recalls nothing already sent', atSec: 1.2 },
      { text: 'On Codex: about 11 s per vision frame, about 13 s from a pause to a question', atSec: 2.1 },
    ],
  },
  {
    type: 'clipa-outro', durationSec: 4.5, headline: 'Next: a company memory that asks only about what changed',
    links: [{ label: 'Demo', url: 'qwadratic.github.io/clipa' }, { label: 'Code', url: 'github.com/qwadratic/clipa' }],
    note: 'All data in this video is synthetic.',
  },
];

// Absolute start of each scene (cross-fades overlap neighbours).
const starts = [];
let t = 0;
for (const s of scenes) { starts.push(t); t += s.durationSec - TRANSITION; }
const total = t + TRANSITION;
const abs = (i, sceneSec) => Number((starts[i] + sceneSec).toFixed(2));
const show = scenes[3];
const warnCut = scenes[6];

const lines = [
  { voice: 'narrator', text: 'Two faces, web and Mac, share one server and one voice.', atSec: 0.3 },
  { voice: 'narrator', text: 'Vision turns frames into observations; the Conductor streams cues back.', atSec: 4.8 },
  { voice: 'narrator', text: 'Frames are masked in the browser; each change becomes one typed observation.', atSec: abs(1, 0.3) },
  { voice: 'narrator', text: 'She never interrupts typing or talking; she prepares early and asks at the pause.', atSec: abs(2, 0.3) },
  { voice: 'narrator', text: 'Live, on the real product: Show.', atSec: abs(3, 0.3) },
  { voice: 'clipa', text: clean(ask.text), atSec: abs(3, show.at(ask.tSec)) },
  { voice: 'narrator', text: 'Reflect: when Show ends, the Work Map is built from the session.', atSec: abs(4, 0.3) },
  { voice: 'narrator', text: 'After one spoken correction, the expert confirms the map.', atSec: abs(5, 0.3) },
  { voice: 'narrator', text: 'Pass it on, a new case.', atSec: abs(6, 0.3) },
  { voice: 'clipa', text: clean(warn.text), atSec: abs(6, warnCut.at(warn.tSec)) },
  { voice: 'narrator', text: 'The new hire fixes it. Clipa warns; she never clicks.', atSec: abs(7, 1.1) },
  { voice: 'narrator', text: 'Honest limits: synthetic data, inputs posted as text, and slow vision on Codex.', atSec: abs(8, 0.3) },
  { voice: 'narrator', text: 'Next: a company memory that asks only about what changed.', atSec: abs(9, 0.3) },
];
const vo = lines.map((l, i) => {
  const next = lines[i + 1]?.atSec ?? total;
  const maxSec = Number((next - l.atSec).toFixed(2));
  const words = l.text.split(/\s+/).length;
  if (l.voice === 'narrator' && words > maxSec * 2.6) throw new Error(`line ${i + 1} has ${words} words for ${maxSec} s`);
  return { id: `t${String(i + 1).padStart(2, '0')}`, voice: l.voice, text: l.text, atSec: l.atSec, maxSec };
});

for (const s of scenes) delete s.at;
writeFileSync('scripts/tech.json', `${JSON.stringify({ transitionSec: TRANSITION, scenes }, null, 2)}\n`);
writeFileSync('scripts/tech-voiceover.json', `${JSON.stringify({ video: 'apps/web/public/videos/clipa-tech.mp4', lines: vo }, null, 2)}\n`);
console.log(`tech.json: ${scenes.length} scenes, ${total.toFixed(1)} s`);
scenes.forEach((s, i) => console.log(`  ${starts[i].toFixed(1).padStart(5)} s  ${s.type.padEnd(12)} ${s.durationSec} s  ${s.heading ?? s.kicker ?? s.title ?? s.headline ?? ''}`));
console.log(`tech-voiceover.json: ${vo.length} lines`);
