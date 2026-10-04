#!/usr/bin/env node
// Adds a voice-over to a rendered video. Each line of the script is fetched as MP3 from the Clipa API
// (GET <base>/api/agent/voiceover/<id>: ElevenLabs TTS on the server, whitelisted lines only), placed on the
// video's timeline and mixed into one track that replaces the silent one. The picture is copied, not re-encoded.
//
//   node video/capture/voiceover.mjs --base https://apprentice.exe.xyz
//   node video/capture/voiceover.mjs --fake --script <file> --out <file>   # offline: tones instead of speech
//
// Options:
//   --base <url>     the API (required unless --fake)
//   --script <file>  default video/scripts/demo-voiceover.json
//   --out <file>     default: the script's "video", overwritten through a temp file
//   --fake           a tone of words/2.6 s per line instead of a download (for offline tests)
//   --refresh        download every line again, even when it is already in video/assets/voiceover/
//
// Paths inside the script ("video") are relative to the repo root; --script and --out are relative to the
// current directory. Downloads go through curl, which follows HTTPS_PROXY. Needs Node 22+, curl, and
// ffmpeg/ffprobe 4.4 or newer on PATH. No npm dependencies.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CACHE = join(ROOT, 'video', 'assets', 'voiceover');
const VOICES = new Set(['narrator', 'clipa', 'expert', 'newhire']);
const GAP = 0.15; // seconds between two clips when a line has to wait for the previous one
const LATE_WARN = 1.5; // warn when a line starts this much later than its atSec
const TONE_HZ = { narrator: 220, clipa: 660, expert: 330, newhire: 440 };

const die = (msg) => {
  console.error(`voiceover: ${msg}`);
  process.exit(1);
};

// ---------- arguments ----------
const args = { script: null, out: null, base: null, fake: false, refresh: false };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  const value = () => process.argv[++i] ?? die(`${a} needs a value`);
  if (a === '--base') args.base = value();
  else if (a === '--script') args.script = value();
  else if (a === '--out') args.out = value();
  else if (a === '--fake') args.fake = true;
  else if (a === '--refresh') args.refresh = true;
  else if (a === '-h' || a === '--help') {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\nimport ')[0].replace(/^#!.*\n/, '').replace(/^\/\/ ?/gm, ''));
    process.exit(0);
  } else die(`unknown argument ${a} (try --help)`);
}
if (!args.fake && !args.base) die('--base <url> is required (or --fake for an offline test)');
const base = args.base?.replace(/\/+$/, '');

// ---------- tools ----------
const run = (cmd, argv, { quiet = false } = {}) => {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) die(`${cmd} could not start: ${r.error.message}`);
  if (r.status !== 0 && !quiet) die(`${cmd} failed (exit ${r.status}):\n${(r.stderr || '').trim().split('\n').slice(-15).join('\n')}`);
  return r;
};
const probeDuration = (file, stream = null) => {
  const sel = stream ? ['-select_streams', stream, '-show_entries', 'stream=duration'] : ['-show_entries', 'format=duration'];
  const out = run('ffprobe', ['-v', 'error', ...sel, '-of', 'default=nw=1:nk=1', file]).stdout.trim().split('\n')[0];
  const sec = Number(out);
  return Number.isFinite(sec) && sec > 0 ? sec : null;
};
const fmt = (n) => n.toFixed(2);

// ---------- script ----------
const scriptPath = args.script ? resolve(args.script) : join(ROOT, 'video', 'scripts', 'demo-voiceover.json');
if (!existsSync(scriptPath)) die(`script not found: ${scriptPath}`);
let script;
try {
  script = JSON.parse(readFileSync(scriptPath, 'utf8'));
} catch (e) {
  die(`${scriptPath} is not valid JSON: ${e.message}`);
}
if (typeof script.video !== 'string' || !Array.isArray(script.lines) || script.lines.length === 0) {
  die(`${scriptPath} needs "video" (a path) and a non-empty "lines" array`);
}
const seen = new Set();
for (const [i, l] of script.lines.entries()) {
  const where = `lines[${i}]${l?.id ? ` (${l.id})` : ''}`;
  if (typeof l?.id !== 'string' || !/^v\d{2}$/.test(l.id)) die(`${where}: id must be "v" plus two digits`);
  if (seen.has(l.id)) die(`${where}: duplicate id`);
  seen.add(l.id);
  if (!VOICES.has(l.voice)) die(`${where}: voice must be one of ${[...VOICES].join(', ')}`);
  if (typeof l.text !== 'string' || !l.text.trim()) die(`${where}: text is empty`);
  if (!Number.isFinite(l.atSec) || l.atSec < 0) die(`${where}: atSec must be a number >= 0`);
  if (l.maxSec !== undefined && !(Number.isFinite(l.maxSec) && l.maxSec > 0)) die(`${where}: maxSec must be a number > 0`);
}
const lines = [...script.lines];
if (lines.some((l, i) => i > 0 && l.atSec < lines[i - 1].atSec)) {
  console.warn('voiceover: warning: lines are not in time order; placing them by atSec');
  lines.sort((a, b) => a.atSec - b.atSec);
}

const videoPath = isAbsolute(script.video) ? script.video : join(ROOT, script.video);
if (!existsSync(videoPath)) die(`video not found: ${videoPath}`);
const outPath = args.out ? resolve(args.out) : videoPath;
const videoSec = probeDuration(videoPath, 'v:0') ?? probeDuration(videoPath);
if (!videoSec) die(`could not read the duration of ${videoPath}`);

// ---------- audio per line ----------
const download = (line, file) => {
  const url = `${base}/api/agent/voiceover/${encodeURIComponent(line.id)}`;
  const tmp = `${file}.part`;
  for (let attempt = 1; ; attempt++) {
    const r = run('curl', ['-sS', '--max-time', '180', '-o', tmp, '-w', '%{http_code} %{content_type}', url], { quiet: true });
    const [code = '000', type = ''] = r.stdout.trim().split(' ');
    if (r.status === 0 && code === '200' && /^audio\//.test(type) && statSync(tmp).size > 0) {
      renameSync(tmp, file);
      return;
    }
    let detail = (r.stderr || '').trim();
    if (existsSync(tmp)) {
      const body = readFileSync(tmp, 'utf8').slice(0, 300);
      try {
        detail = JSON.parse(body).error ?? body;
      } catch {
        detail = detail || body.replace(/\s+/g, ' ');
      }
      rmSync(tmp, { force: true });
    }
    const retry = code === '000' || code === '502' || code === '504';
    if (!retry || attempt === 3) die(`${line.id}: GET ${url} -> HTTP ${code}${type ? ` ${type}` : ''}${detail ? `: ${detail}` : ''}`);
    console.warn(`voiceover: ${line.id}: HTTP ${code}, retrying (${attempt}/3)`);
  }
};

const tone = (line, file) => {
  const words = line.text.trim().split(/\s+/).length;
  const sec = Math.max(0.3, words / 2.6);
  const fade = Math.min(0.05, sec / 4);
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `sine=frequency=${TONE_HZ[line.voice]}:sample_rate=48000:duration=${sec.toFixed(3)}`,
    '-af', `volume=0.3,afade=t=in:d=${fade},afade=t=out:st=${(sec - fade).toFixed(3)}:d=${fade}`,
    '-c:a', 'libmp3lame', '-b:a', '128k', file,
  ]);
};

const dir = args.fake ? join(CACHE, 'fake') : CACHE; // fake tones never land where real lines are cached
mkdirSync(dir, { recursive: true });
for (const line of lines) {
  const file = join(dir, `${line.id}.mp3`);
  const stamp = join(dir, `${line.id}.txt`);
  const said = `${line.voice}: ${line.text.trim()}\n`;
  if (args.fake) tone(line, file);
  else {
    const stale = existsSync(file) && existsSync(stamp) && readFileSync(stamp, 'utf8') !== said;
    if (stale) console.warn(`voiceover: ${line.id}: the cached clip was made for another text; downloading it again`);
    if (args.refresh || stale || !existsSync(file)) {
      download(line, file);
      console.log(`voiceover: ${line.id} downloaded`);
    }
  }
  writeFileSync(stamp, said);
  line.file = file;
  line.len = probeDuration(file);
  if (!line.len) die(`${line.id}: could not read the duration of ${file}`);
}

// ---------- schedule ----------
let prevEnd = -Infinity;
const warnings = [];
for (const line of lines) {
  line.start = Math.max(line.atSec, prevEnd + GAP);
  line.late = line.start - line.atSec;
  prevEnd = line.start + line.len;
  if (line.late > LATE_WARN) warnings.push(`${line.id} starts ${fmt(line.late)} s late (at ${fmt(line.atSec)}, plays at ${fmt(line.start)})`);
  if (line.maxSec !== undefined && line.len > line.maxSec + 0.05) warnings.push(`${line.id} is ${fmt(line.len)} s, longer than its ${fmt(line.maxSec)} s slot`);
}
if (prevEnd > videoSec) warnings.push(`the voice-over ends at ${fmt(prevEnd)} s, ${fmt(prevEnd - videoSec)} s past the end of the video (${fmt(videoSec)} s); the rest is cut`);

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
console.log(`\n${pad('id', 4)} ${pad('voice', 9)} ${lpad('at', 7)} ${lpad('start', 7)} ${lpad('len', 6)} ${lpad('max', 6)}  late`);
for (const l of lines) {
  const late = l.late > 0.005 ? `+${fmt(l.late)}${l.late > LATE_WARN ? ' LATE' : ''}` : '';
  const long = l.maxSec !== undefined && l.len > l.maxSec + 0.05 ? ' (long)' : '';
  console.log(`${pad(l.id, 4)} ${pad(l.voice, 9)} ${lpad(fmt(l.atSec), 7)} ${lpad(fmt(l.start), 7)} ${lpad(fmt(l.len), 6)} ${lpad(l.maxSec !== undefined ? fmt(l.maxSec) : '-', 6)}  ${late}${long}`);
}
console.log(`video ${fmt(videoSec)} s, voice-over ends at ${fmt(prevEnd)} s\n`);
for (const w of warnings) console.warn(`voiceover: warning: ${w}`);

// ---------- mix ----------
// Input 0 is the video; the clips are inputs 1..n. Each clip is delayed to its start, the clips are summed
// (amix without normalisation, so no clip gets quieter), cut at the video end, loudness-normalised to about
// -16 LUFS and padded with silence to the exact video length.
const inputs = ['-i', videoPath, ...lines.flatMap((l) => ['-i', l.file])];
const mixGraph = () => {
  const parts = lines.map((l, i) => {
    const ms = Math.round(l.start * 1000);
    return `[${i + 1}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,adelay=${ms}|${ms}[c${i}]`;
  });
  const labels = lines.map((_, i) => `[c${i}]`).join('');
  parts.push(lines.length > 1 ? `${labels}amix=inputs=${lines.length}:normalize=0:duration=longest[mix]` : `${labels}anull[mix]`);
  return parts;
};
const D = videoSec.toFixed(3);
const LOUD = 'I=-16:TP=-1.5:LRA=11';

// Pass 1 measures the loudness, pass 2 applies it linearly (no pumping between lines).
const measure = run('ffmpeg', [
  '-hide_banner', '-nostats', '-y', ...inputs,
  '-filter_complex', [...mixGraph(), `[mix]atrim=end=${D},loudnorm=${LOUD}:print_format=json[m]`].join(';'),
  '-map', '[m]', '-f', 'null', '-',
]);
let loud = `loudnorm=${LOUD}`;
try {
  const json = JSON.parse(measure.stderr.slice(measure.stderr.lastIndexOf('{'), measure.stderr.lastIndexOf('}') + 1));
  const m = ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'].map((k) => Number(json[k]));
  if (m.every(Number.isFinite)) {
    loud += `:measured_I=${m[0]}:measured_TP=${m[1]}:measured_LRA=${m[2]}:measured_thresh=${m[3]}:offset=${m[4]}:linear=true`;
    console.log(`voiceover: measured ${json.input_i} LUFS, normalising to -16 LUFS`);
  } else console.warn('voiceover: warning: loudness not measurable; using one-pass loudnorm');
} catch {
  console.warn('voiceover: warning: could not read the loudness measurement; using one-pass loudnorm');
}

mkdirSync(dirname(outPath), { recursive: true });
const tmpOut = join(dirname(outPath), `.${basename(outPath)}.voiceover-tmp.mp4`);
try {
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', ...inputs,
    '-filter_complex', [...mixGraph(), `[mix]atrim=end=${D},${loud},aresample=48000,apad=whole_dur=${D},atrim=end=${D}[vo]`].join(';'),
    '-map', '0:v:0', '-map', '[vo]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart', '-f', 'mp4', tmpOut,
  ]);
  renameSync(tmpOut, outPath);
} finally {
  rmSync(tmpOut, { force: true });
}

const v = probeDuration(outPath, 'v:0');
const a = probeDuration(outPath, 'a:0');
console.log(`voiceover: wrote ${outPath} (video ${v ? fmt(v) : '?'} s, audio ${a ? fmt(a) : '?'} s, ${(statSync(outPath).size / 1e6).toFixed(1)} MB)`);
if (warnings.length) console.log(`voiceover: ${warnings.length} warning(s) above`);
