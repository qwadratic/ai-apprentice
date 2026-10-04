// Records the whole journey on the live web app, Show -> Reflect -> Pass it on, as one 1920x1080 video.
//
//   npx tsx recorder/journey.ts [app url]
//
// Headless Chrome can neither share a screen nor talk, so two inputs are simulated, and only those:
//   - the screen: instead of frames for the vision step, the script posts the typed `screen_activity` observations the
//     vision step would produce (the conductor protocol accepts observations from a client), describing what the demo
//     workspace in the page really shows at that moment;
//   - the voice: the voice signed-URL request is blocked, so no voice conversation opens (the app keeps running without
//     voice), and the expert's and the new hire's spoken answers are posted as `transcript` events.
// Everything else is the product: the page, its sessions, the conductor, the LLM tasks, the Work Map, the cues. The page
// and the script post to the same session, so the script renumbers the page's event seqs to keep one increasing series.
//
// Output in assets/recordings/: journey.mp4, journey.json (markers in seconds on the mp4) and journey.cues.json (every
// cue the conductor sent, with its time on the mp4). No token or signed URL is printed or written.
import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Locator, type Page } from 'playwright-core';
import { resolveBrowser } from '../lib/browser';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = process.argv[2] ?? 'https://qwadratic.github.io/clipa/';
const API = 'https://apprentice.exe.xyz';
const ORIGIN = new URL(APP).origin;
const NAME = 'journey';
const viewport = { width: 1920, height: 1080 };

const CURSOR_SCRIPT = `
(() => {
  if (window.__recCursor) return;
  window.__recCursor = true;
  const make = () => {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:0;top:0;width:32px;height:32px;z-index:2147483647;pointer-events:none;transform:translate(-200px,-200px)';
    el.innerHTML = '<svg viewBox="0 0 24 24" width="32" height="32"><path d="M3 2l7 18 2.6-7.4L20 10z" fill="#ffffff" stroke="#0f2d2a" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(el);
    addEventListener('mousemove', (e) => { el.style.transform = 'translate(' + (e.clientX - 4) + 'px,' + (e.clientY - 3) + 'px)'; }, true);
    addEventListener('mousedown', (e) => {
      const ring = document.createElement('div');
      ring.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;border-radius:50%;border:4px solid #17b3a3;width:20px;height:20px;left:' + (e.clientX - 10) + 'px;top:' + (e.clientY - 10) + 'px;opacity:.95;transition:all 450ms ease-out';
      document.documentElement.appendChild(ring);
      requestAnimationFrame(() => { ring.style.transform = 'scale(3.4)'; ring.style.opacity = '0'; });
      setTimeout(() => ring.remove(), 600);
    }, true);
  };
  if (document.documentElement) make(); else addEventListener('DOMContentLoaded', make);
})();
`;

type Session = { id: string; token: string; at: number };
type CueRow = { atMs: number; session: string; seq: number; mode: string | null; type: string; text?: string; reason?: string; extra?: unknown };

const began = Date.now();
const sessions: Session[] = [];
const cues: CueRow[] = [];
const markers: { marker: string; atMs: number }[] = [];
const seqs = new Map<string, number>();
const clocks = new Map<string, { atMs: number; wall: number }>();
const streams: AbortController[] = [];

const log = (...parts: unknown[]): void => console.log(`+${((Date.now() - began) / 1000).toFixed(1)}s`, ...parts);
const mark = (marker: string): void => { markers.push({ marker, atMs: Date.now() }); log(`[marker] ${marker}`); };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const short = (id: string): string => id.slice(0, 8);
const headers = (s: Session, extra: Record<string, string> = {}): Record<string, string> => ({
  Origin: ORIGIN, Accept: 'application/json', Authorization: `Bearer ${s.token}`, ...extra,
});

/** Reads the conductor's cue stream of one session (a second web face; the page has its own). */
const followCues = (s: Session): void => {
  const ac = new AbortController();
  streams.push(ac);
  void (async () => {
    try {
      const res = await fetch(`${API}/api/agent/conductor/${s.id}/cues?after=-1&client=web`, { headers: headers(s, { Accept: 'text/event-stream' }), signal: ac.signal });
      if (res.status !== 200 || !res.body) { log(`cue stream ${short(s.id)} -> ${res.status}`); return; }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
          if (!data) continue;
          let env: { seq?: number; mode?: string | null; cue?: Record<string, unknown> };
          try { env = JSON.parse(data); } catch { continue; }
          const c = env.cue;
          if (!c || typeof c.type !== 'string') continue;
          if (cues.some((r) => r.session === s.id && r.seq === env.seq)) continue;
          const row: CueRow = { atMs: Date.now(), session: s.id, seq: env.seq ?? -1, mode: env.mode ?? null, type: c.type };
          if (typeof c.text === 'string' && c.type !== 'open_web') row.text = c.text;
          if (typeof c.reason === 'string') row.reason = c.reason;
          if (c.type === 'map') row.extra = { version: c.version, confirmed: c.confirmed, map: c.map };
          if (c.type === 'warn') row.extra = { guardrailId: c.guardrailId };
          if (c.type === 'ask') row.extra = { topic: c.topic };
          cues.push(row);
          const what = row.text ? `"${row.text.slice(0, 160)}"` : row.reason ? `reason="${row.reason}"` : c.type === 'map' ? `v${String(c.version)} confirmed=${String(c.confirmed)}` : '';
          if (!['presence', 'state'].includes(c.type)) log(`CUE ${short(s.id)} #${row.seq} ${row.mode ?? '-'} ${c.type} ${what}`);
        }
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') log('cue stream error', (error as Error).name);
    }
  })();
};

/** Posts conductor events to a session as the page would, on the shared seq series. */
const inject = async (s: Session, events: Record<string, unknown>[]): Promise<void> => {
  const clock = clocks.get(s.id);
  const atMs = clock ? Math.max(0, Math.round(clock.atMs + (Date.now() - clock.wall))) : 0;
  const batch = events.map((event) => {
    const seq = (seqs.get(s.id) ?? 0) + 1;
    seqs.set(s.id, seq);
    return { seq, atMs, event };
  });
  const res = await fetch(`${API}/api/agent/conductor/${s.id}/events`, {
    method: 'POST', headers: headers(s, { 'Content-Type': 'application/json' }), body: JSON.stringify({ events: batch }),
  });
  log(`inject ${short(s.id)} [${events.map((e) => String(e.type)).join(', ')}] -> ${res.status}`);
};

const nowMs = (s: Session): number => {
  const clock = clocks.get(s.id);
  return clock ? Math.max(0, Math.round(clock.atMs + (Date.now() - clock.wall))) : 0;
};

let obsCount = 0;
/** A typed screen observation, as the vision step would post it for the shared screen. */
const observation = (s: Session, summary: string, change: string | null, pendingAction: string | null): Record<string, unknown> => ({
  type: 'observation',
  observation: {
    id: `rec-obs-${++obsCount}-${Date.now()}`, kind: 'screen_activity', timestampMs: nowMs(s), evidenceIds: [],
    facts: { app: 'Demo workspace', surface: 'Order → email → ticket', summary, change, pendingAction, regions: [] },
  },
});

/** The session the page is on after a Start: a new one if it made one within a few seconds, else the latest. */
const waitSession = async (after: number, timeoutMs = 25_000): Promise<Session | null> => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const s = sessions.find((x) => x.at >= after);
    if (s) return s;
    await sleep(200);
  }
  return sessions[sessions.length - 1] ?? null;
};

const waitCue = async (s: Session | null, types: string[], fromIndex: number, timeoutMs: number): Promise<CueRow | null> => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const hit = cues.slice(fromIndex).find((c) => (s === null || c.session === s.id) && types.includes(c.type));
    if (hit) return hit;
    await sleep(250);
  }
  log(`no ${types.join('/')} cue within ${Math.round(timeoutMs / 1000)} s`);
  return null;
};

let cursor = { x: viewport.width / 2, y: viewport.height / 2 };
const glideTo = async (page: Page, locator: Locator, ms = 700): Promise<boolean> => {
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: 8000 });
    const box = await locator.boundingBox();
    if (!box) return false;
    const from = cursor;
    const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const t0 = Date.now();
    for (;;) {
      const p = Math.min(1, (Date.now() - t0) / ms);
      const ease = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      await page.mouse.move(from.x + (to.x - from.x) * ease, from.y + (to.y - from.y) * ease);
      if (p >= 1) break;
      await page.waitForTimeout(16);
    }
    cursor = to;
    return true;
  } catch {
    return false;
  }
};

const click = async (page: Page, locator: Locator, label: string): Promise<boolean> => {
  try {
    await locator.waitFor({ state: 'visible', timeout: 10_000 });
    await glideTo(page, locator);
    await locator.click({ delay: 90, timeout: 8000 });
    log(`click ${label}`);
    return true;
  } catch (error) {
    log(`click ${label} failed: ${(error as Error).message.split('\n')[0]}`);
    return false;
  }
};

const dismissBanner = async (page: Page): Promise<void> => {
  const dismiss = page.getByRole('button', { name: 'Dismiss' }).first();
  if (await dismiss.isVisible().catch(() => false)) await click(page, dismiss, 'Dismiss');
};

/** Picks a canned spoken answer for a question Clipa asked (the expert's knowledge, said aloud in a real run). */
const expertAnswer = (question: string): string => {
  const q = question.toLowerCase();
  if (/(unknown|not sure|unsure|can't tell|cannot tell|stop|ask someone|check with)/.test(q)) return 'If I cannot tell which customer it is, I ask the account owner before sending. I never guess.';
  if (/(other customer|every|all customers|only|always|apply|anyone else)/.test(q)) return 'Only customer_07. They asked to get it as text. Everyone else gets the usual template image.';
  if (/\bwhy\b/.test(q)) return 'Because customer_07 asked us to send the delivery address and time as text in the email. Only for them; an extra image is fine.';
  if (/(remove|image|attach|picture|screenshot)/.test(q)) return 'I would not remove it. The image can stay as an extra; what matters is that the address and the delivery time are written in the email text.';
  return 'Because customer_07 asked us to send the delivery address and time as text in the email. Only for them; an extra image is fine.';
};

/** The index of the first cue of these types for this session at or after `from`, waiting up to `timeoutMs`. */
const nextCueIndex = async (s: Session, types: string[], from: number, timeoutMs: number): Promise<number> => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    for (let i = from; i < cues.length; i++) if (cues[i]!.session === s.id && types.includes(cues[i]!.type)) return i;
    await sleep(250);
  }
  log(`no ${types.join('/')} cue within ${Math.round(timeoutMs / 1000)} s`);
  return -1;
};

/** Clicks a Start button until the page is live (its End button shows) and returns the page's session. */
const startStage = async (page: Page, start: RegExp, end: RegExp, label: string): Promise<Session | null> => {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const t = Date.now();
    await click(page, page.getByRole('button', { name: start }).first(), `${label} (attempt ${attempt})`);
    const until = Date.now() + 15_000;
    while (Date.now() < until) {
      const fresh = sessions.find((x) => x.at >= t);
      const live = await page.getByRole('button', { name: end }).first().isVisible().catch(() => false);
      if (live && (fresh || sessions.length > 0)) return fresh ?? sessions[sessions.length - 1]!;
      await sleep(300);
    }
    log(`${label}: not live after attempt ${attempt}`);
  }
  return sessions[sessions.length - 1] ?? null;
};

const main = async (): Promise<void> => {
  const outDir = path.join(root, 'assets', 'recordings');
  const tmpDir = path.join(outDir, `.tmp-${NAME}`);
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  const browser = resolveBrowser();
  const proxyServer = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  const launched = await chromium.launch({
    executablePath: browser?.executable,
    headless: true,
    proxy: proxyServer ? { server: proxyServer } : undefined,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--force-device-scale-factor=1'],
  });
  const context = await launched.newContext({ viewport, deviceScaleFactor: 1, ignoreHTTPSErrors: true, permissions: ['microphone'] });
  await context.addInitScript(CURSOR_SCRIPT);
  // No voice conversation is opened: the signed-URL request never leaves the browser.
  await context.route('**/*', (route) => {
    const u = route.request().url();
    if (u.includes('/api/agent/elevenlabs/') || u.includes('elevenlabs.io')) {
      log(`blocked ${new URL(u).pathname}`);
      return route.abort('blockedbyclient');
    }
    return route.fallback();
  });
  // One increasing seq series per session for the page's events and the script's.
  await context.route(/\/api\/agent\/conductor\/[^/]+\/events(\?.*)?$/, (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.fallback();
    const id = decodeURIComponent(new URL(req.url()).pathname.split('/')[4] ?? '');
    let body: { events?: { seq: number; atMs: number }[] };
    try { body = JSON.parse(req.postData() ?? ''); } catch { return route.fallback(); }
    for (const env of body.events ?? []) {
      const seq = (seqs.get(id) ?? 0) + 1;
      seqs.set(id, seq);
      env.seq = seq;
      clocks.set(id, { atMs: env.atMs, wall: Date.now() });
    }
    return route.continue({ postData: JSON.stringify(body) });
  });

  const page = await context.newPage();
  page.on('response', async (res) => {
    try {
      const req = res.request();
      if (req.method() !== 'POST' || new URL(res.url()).pathname !== '/api/agent/sessions') return;
      if (res.status() !== 201) { log(`session request -> ${res.status()}`); return; }
      const j = (await res.json()) as { sessionId?: string; token?: string };
      if (!j.sessionId || !j.token) return;
      const s = { id: j.sessionId, token: j.token, at: Date.now() };
      sessions.push(s);
      log(`session ${short(s.id)} (token kept in memory only)`);
      followCues(s);
    } catch { /* not a session */ }
  });

  type Shot = { atMs: number; file: string };
  const shots: Shot[] = [];
  const cdp = await context.newCDPSession(page);
  cdp.on('Page.screencastFrame', (event) => {
    const file = path.join(tmpDir, `${String(shots.length).padStart(6, '0')}.jpg`);
    writeFileSync(file, Buffer.from(event.data, 'base64'));
    shots.push({ atMs: (event.metadata.timestamp ?? Date.now() / 1000) * 1000, file });
    void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => undefined);
  });

  let readyAtMs = 0;
  let endAtMs = 0;
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await page.goto(APP, { waitUntil: 'load', timeout: 30_000 });
        await page.getByRole('button', { name: 'Start Show' }).waitFor({ state: 'visible', timeout: 25_000 });
        break;
      } catch (error) {
        if (attempt >= 6) throw error;
        log(`load attempt ${attempt} failed (${(error as Error).message.split('\n')[0]}), retrying`);
        await sleep(2000);
      }
    }
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: viewport.width, maxHeight: viewport.height, everyNthFrame: 1 });
    await page.mouse.move(cursor.x, cursor.y);
    readyAtMs = Date.now();
    mark('open');
    await sleep(2500);

    // ---- 1. Show: the expert works in the email; Clipa asks why at the pause -------------------------------------
    mark('show');
    let t = Date.now();
    const show = await startStage(page, /^Start Show/, /^End Show/, 'Start Show');
    if (!show) throw new Error('Show did not start a session');
    await sleep(3000);
    await dismissBanner(page);
    await inject(show, [
      { type: 'share', state: 'capturing', reason: null },
      observation(show,
        'Order ORD-2041 for customer_07 is open (delivery address 14 Sample Lane, 1010 Exampletown; delivery window 2026-10-12 14:00-16:00). Next to it a draft email "Delivery update — ORD-2041" to customer_07 says "Please see the attached delivery summary." and has the delivery summary image attached.',
        null, null),
    ]);
    await sleep(4000);
    mark('show-typing');
    const body = page.locator('textarea[data-field="body"]').first();
    if (await glideTo(page, body)) {
      await body.click();
      await page.keyboard.press('Control+End');
      await page.keyboard.type('\n\nDelivery address: 14 Sample Lane, 1010 Exampletown\nDelivery time: 12 Oct, 14:00-16:00', { delay: 45 });
    }
    await sleep(1200);
    const cueIndex = cues.length;
    await inject(show, [
      observation(show,
        'In the draft email to customer_07 the expert typed the delivery address (14 Sample Lane, 1010 Exampletown) and the delivery time (12 Oct, 14:00-16:00) into the message text. The delivery summary image is still attached.',
        'The delivery address and the delivery time were copied from the order into the email text, although the same details are in the attached image.',
        null),
    ]);
    mark('show-change');
    const ask = await waitCue(show, ['ask'], cueIndex, 90_000);
    if (ask) mark('show-ask');
    await sleep(6000);
    await inject(show, [{ type: 'talking', by: 'person', active: true }]);
    await sleep(1500);
    const answer1 = expertAnswer(ask?.text ?? '');
    await inject(show, [{ type: 'transcript', role: 'expert', text: answer1 }, { type: 'talking', by: 'person', active: false }]);
    mark('show-answer');
    await sleep(7000);
    // A second moment: the expert keeps the image and moves to Send.
    const cueIndex2 = cues.length;
    await inject(show, [
      observation(show,
        'The draft to customer_07 now has the delivery address and time in the text and the delivery summary image attached. The expert points at "Send demo email".',
        'The expert kept the image attachment and is about to send.',
        'Send demo email'),
    ]);
    const send = page.getByRole('button', { name: 'Send demo email' }).first();
    await glideTo(page, send);
    mark('show-change2');
    const ask2 = await waitCue(show, ['ask'], cueIndex2, 45_000);
    if (ask2) {
      mark('show-ask2');
      await sleep(5000);
      await inject(show, [{ type: 'transcript', role: 'expert', text: expertAnswer(ask2.text ?? '') }]);
      mark('show-answer2');
      await sleep(5000);
    }
    t = Date.now();
    await click(page, page.getByRole('button', { name: 'End Show' }).first(), 'End Show');
    mark('show-end');
    await sleep(4000);

    // ---- 2. Reflect: the Work Map, open points, the teach-back, a correction, the confirmation -----------------------
    await click(page, page.getByRole('tab', { name: /Reflect/ }).first(), 'Reflect tab');
    await sleep(2500);
    mark('reflect');
    t = Date.now();
    const reflect = await startStage(page, /Start Reflect/, /^End Reflect/, 'Start Reflect');
    if (!reflect) throw new Error('Reflect did not start a session');
    await sleep(2500);
    await dismissBanner(page);
    const reflectFrom = cues.length;
    const mapAt = await nextCueIndex(reflect, ['map'], 0, 180_000);
    if (mapAt >= 0) mark('reflect-map');
    let corrected = false;
    let confirmedClick = false;
    let cursorIdx = mapAt >= 0 ? mapAt + 1 : reflectFrom;
    for (let round = 0; round < 6; round++) {
      const at = await nextCueIndex(reflect, ['ask', 'teachback'], cursorIdx, 90_000);
      if (at < 0) break;
      cursorIdx = at + 1;
      const next = cues[at]!;
      if (next.type === 'ask') {
        mark(`reflect-ask-${round}`);
        await sleep(5000);
        await inject(reflect, [{ type: 'transcript', role: 'expert', text: expertAnswer(next.text ?? '') }]);
        mark(`reflect-answer-${round}`);
        await sleep(3000);
        continue;
      }
      // The teach-back.
      mark(corrected ? 'reflect-teachback-2' : 'reflect-teachback');
      await sleep(9000);
      if (!corrected) {
        corrected = true;
        await inject(reflect, [{ type: 'transcript', role: 'expert', text: 'One correction: it is the delivery time window, not only the date. Otherwise that is right.' }]);
        mark('reflect-correction');
        await sleep(4000);
        continue;
      }
      break;
    }
    const confirm = page.getByRole('button', { name: /^Confirm/ }).first();
    if (await confirm.isVisible().catch(() => false)) {
      confirmedClick = await click(page, confirm, 'Confirm');
    } else {
      await inject(reflect, [{ type: 'transcript', role: 'expert', text: 'Yes, that is right. Confirmed.' }]);
    }
    mark('reflect-confirm');
    const confirmed = await waitCue(reflect, ['map'], cues.length - 1, 45_000);
    log(`map after confirm: ${confirmed ? 'received' : 'none'} (clicked=${String(confirmedClick)})`);
    await sleep(6000);

    // ---- 3. Pass it on: a new case; Clipa warns before the step that breaks the rule; the allow case stays quiet -----
    await click(page, page.getByRole('tab', { name: /Pass it on/ }).first(), 'Pass it on tab');
    await sleep(2500);
    mark('teach');
    t = Date.now();
    const teach = await startStage(page, /Start Pass it on/, /^End Pass it on/, 'Start Pass it on');
    if (!teach) throw new Error('Pass it on did not start a session');
    await sleep(3000);
    await dismissBanner(page);
    const caseSelect = page.locator('select[data-field="case"]').first();
    await glideTo(page, caseSelect);
    await caseSelect.selectOption({ label: 'New order · customer_07 · attachment' }).catch(() => undefined);
    await sleep(2500);
    await inject(teach, [
      { type: 'share', state: 'capturing', reason: null },
      observation(teach,
        'A new hire has order ORD-2057 for customer_07 open (82 Sample Walk, 1010 Exampletown; 2026-10-13 09:00-11:00). The draft "Delivery update — ORD-2057" to customer_07 only says "Please see the attached delivery summary." and has the delivery image attached; the address and time are not in the text.',
        null, null),
    ]);
    await sleep(3500);
    const sendNow = page.getByRole('button', { name: 'Send demo email' }).first();
    await glideTo(page, sendNow);
    const warnFrom = cues.length;
    await inject(teach, [
      observation(teach,
        'The new hire is about to click "Send demo email" on the draft to customer_07 for ORD-2057. The message text has no delivery address and no delivery time; they are only in the attached image.',
        'The new hire moved to Send.',
        'Send demo email'),
    ]);
    mark('teach-send');
    const warn = await waitCue(teach, ['warn'], warnFrom, 75_000);
    if (warn) mark('teach-warn');
    await sleep(9000);
    // The new hire fixes it.
    const body2 = page.locator('textarea[data-field="body"]').first();
    if (await glideTo(page, body2)) {
      await body2.click();
      await page.keyboard.press('Control+End');
      await page.keyboard.type('\n\nDelivery address: 82 Sample Walk, 1010 Exampletown\nDelivery time: 13 Oct, 09:00-11:00', { delay: 40 });
    }
    await inject(teach, [
      observation(teach,
        'The new hire typed the delivery address and time into the email to customer_07 for ORD-2057; the image is still attached.',
        'The address and time are now in the message text.',
        null),
    ]);
    mark('teach-fixed');
    await sleep(7000);
    // The allow case: another customer, image only. The personal rule does not apply.
    await glideTo(page, caseSelect);
    await caseSelect.selectOption({ label: 'Order · customer_03' }).catch(() => undefined);
    await sleep(2500);
    await glideTo(page, sendNow);
    const quietFrom = cues.length;
    await inject(teach, [
      observation(teach,
        'The new hire has order DEMO-3001 for customer_03 open and is about to click "Send demo email" on the draft to customer_03, which says "Please see the attached delivery summary." with the delivery image attached.',
        'The new hire switched to the order for customer_03 and moved to Send.',
        'Send demo email'),
    ]);
    mark('teach-allow');
    await sleep(25_000);
    const extraWarn = cues.slice(quietFrom).find((c) => c.session === teach.id && c.type === 'warn');
    log(`allow case: ${extraWarn ? `WARNED: ${extraWarn.text}` : 'no warning'}`);
    mark('teach-allow-end');

    // ---- Off the record ------------------------------------------------------------------------------------------
    await click(page, page.getByRole('button', { name: 'Off the record' }).first(), 'Off the record');
    mark('off');
    await sleep(5000);
    endAtMs = Date.now();
  } finally {
    endAtMs ||= Date.now();
    for (const s of streams) s.abort();
    await cdp.send('Page.stopScreencast').catch(() => undefined);
    await context.close();
    await launched.close();
  }

  shots.sort((a, b) => a.atMs - b.atMs);
  const startMs = Math.max(shots[0]!.atMs, readyAtMs - 200);
  const first = Math.max(0, shots.findLastIndex((s) => s.atMs <= startMs));
  const used = shots.slice(first);
  const lines: string[] = ['ffconcat version 1.0'];
  used.forEach((shot, i) => {
    const from = Math.max(shot.atMs, startMs);
    const until = used[i + 1]?.atMs ?? endAtMs;
    const seconds = (until - from) / 1000;
    if (seconds <= 0) return;
    lines.push(`file '${path.basename(shot.file)}'`, `duration ${seconds.toFixed(4)}`);
  });
  lines.push(`file '${path.basename(used[used.length - 1]!.file)}'`);
  const listFile = path.join(tmpDir, 'frames.txt');
  writeFileSync(listFile, `${lines.join('\n')}\n`);
  const toSec = (ms: number): number => Number(((ms - startMs) / 1000).toFixed(2));
  writeFileSync(path.join(outDir, `${NAME}.json`), `${JSON.stringify({
    name: NAME, url: APP, recordedAt: new Date().toISOString(), durationSec: toSec(endAtMs),
    markers: markers.map((m) => ({ marker: m.marker, tSec: toSec(m.atMs) })),
  }, null, 2)}\n`);
  writeFileSync(path.join(outDir, `${NAME}.cues.json`), `${JSON.stringify(cues.map((c) => ({ ...c, tSec: toSec(c.atMs), session: short(c.session) })), null, 2)}\n`);
  const mp4 = path.join(outDir, `${NAME}.mp4`);
  const tmpMp4 = path.join(outDir, `.${NAME}.tmp.mp4`);
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-fps_mode', 'cfr', '-r', '30', '-vf', 'scale=in_range=pc:out_range=tv',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-movflags', '+faststart', '-an', tmpMp4,
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
  renameSync(tmpMp4, mp4);
  rmSync(tmpDir, { recursive: true, force: true });
  log(`Recorded -> ${mp4} (${(statSync(mp4).size / 1024 / 1024).toFixed(1)} MB)`);
  log(`Markers: ${markers.map((m) => `${m.marker}=${toSec(m.atMs)}`).join(', ')}`);
};

main().catch((error: unknown) => {
  console.error(error);
  for (const s of streams) s.abort();
  process.exit(1);
});
