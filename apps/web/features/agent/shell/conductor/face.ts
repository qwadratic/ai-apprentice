// The web face of the conductor: renders each cue and reports when it is done. The conductor decides what Clipa says
// and when; this class only shows, speaks and points, through the host (the shell controller), and answers `cue_done`.
//   - ask, warn, say, teachback and a guide with `speak` go to the voice agent as `[ASK] <text>`. `cue_done spoken` is sent
//     when the agent has finished saying it; `shown` when there was no voice to say it (the bubble shows it).
//   - A cue past its `expiresAtMs`, or a spoken cue that arrives while the person types or talks, is dropped: `skipped`.
//   - Off the record nothing is rendered except `state hidden`.
//   - Cues replayed from before this page joined a hand-over (`historyUntil`) only restore the map and the teach-back.
//   - thought goes to the store (the thought bubble beside Clipa) and is never spoken; attention makes Clipa flash and go to
//     its target; stage opens a stage the way a click on the rail does.
import type { ClientTimers } from './client.ts';
import type { ClientEvent, ClipaPose, ConductorMode, CueEnvelope, CueOutcome, Region, Target } from './protocol.ts';
import { MAX_SAID } from './store.ts';
import type { ConductorLine, ConductorStore, SaidItem } from './store.ts';
import { clipaHint } from './targets.ts';

export interface FaceHost {
  /** Says `text` through the voice agent ([ASK]); false when the voice cannot take it now. */
  speak(text: string, maxChars?: number): boolean;
  /** A contextual update for the voice agent (never spoken). */
  context(text: string): void;
  /** The person types or talks right now. */
  personBusy(): boolean;
  /**
   * One Clipa motion: `text` is her line ('' clears the bubble, null keeps it) and `target` where she goes (null: nowhere,
   * undefined: she stays). A line with a target is said beside it; `kind` warn is said in the warning pose.
   */
  present(text: string | null, target: Target | null | undefined, kind?: ConductorLine['kind']): void;
  /** The journey step of a guide cue, for the rail (null clears it). */
  guide(step: { phase: string; step: string; text: string } | null): void;
  pose(pose: ClipaPose): void;
  log(type: string, text: string): void;
  /** The conductor's session time now, when this page knows it exactly (its own session), else null. */
  sessionNow(): number | null;
  /** Epoch ms (Date.now()). */
  now(): number;
  send(event: ClientEvent): void;
  timers: ClientTimers;
  /** Clipa flashes briefly (the person should look where she goes). */
  attention?(target: Target | null): void;
  /** Opens a stage the way a click on its tab of the rail does. */
  stage?(mode: ConductorMode): void;
}

/** A spoken cue whose speech never starts is given up after this long. */
export const SPEECH_START_TIMEOUT_MS = 12_000;
/** A spoken cue whose end is never reported counts as said after this long. */
export const SPEECH_MAX_MS = 45_000;
/** A teach-back may be read in full (about a minute of speech); other lines keep the agent's usual limit. */
export const TEACHBACK_MAX_CHARS = 1200;
/** A thought bubble shows this long (the CSS fades it in and out within it). */
export const THOUGHT_MS = 4000;
const BUBBLE_MAX_CHARS = 280;

interface Speaking { cueId: string; started: boolean; timer: unknown }

export class ConductorFace {
  private readonly host: FaceHost;
  private readonly store: ConductorStore;
  /** Cues at or below this seq were sent before this page joined: only the map and the teach-back are restored. */
  historyUntil = -1;
  private speaking: Speaking | null = null;
  private readonly done = new Set<string>();
  private latest: { atMs: number; localMs: number } | null = null;
  private targetCueId: string | null = null;
  private thoughtTimer: unknown = null;

  constructor(host: FaceHost, store: ConductorStore) {
    this.host = host;
    this.store = store;
  }

  /** The conductor's clock now: exact for this page's own session, else estimated from the newest cue seen. */
  private conductorNow(): number | null {
    const exact = this.host.sessionNow();
    if (exact !== null) return exact;
    return this.latest === null ? null : this.latest.atMs + (this.host.now() - this.latest.localMs);
  }

  private finish(cueId: string, outcome: CueOutcome): void {
    if (this.done.has(cueId)) return;
    this.done.add(cueId);
    if (this.done.size > 200) this.done.delete(this.done.values().next().value as string);
    if (this.speaking?.cueId === cueId) {
      if (this.speaking.timer !== null) this.host.timers.clearTimeout(this.speaking.timer);
      this.speaking = null;
    }
    const said = this.store.getState().said;
    if (said.some((s) => s.cueId === cueId)) this.store.set({ said: said.map((s) => (s.cueId === cueId ? { ...s, outcome } : s)) });
    this.host.send({ type: 'cue_done', cueId, outcome });
  }

  /** Keeps what Clipa asked, warned or said, for the mode views (outcome filled in by finish). */
  private remember(cueId: string, kind: SaidItem['kind'], text: string, atMs: number): void {
    const said = [...this.store.getState().said, { cueId, kind, text, atMs, outcome: 'pending' as const }];
    this.store.set({ said: said.length > MAX_SAID ? said.slice(said.length - MAX_SAID) : said });
  }

  private bubbleText(line: ConductorLine | null): string {
    if (line === null) return '';
    return line.text.length > BUBBLE_MAX_CHARS ? `${line.text.slice(0, BUBBLE_MAX_CHARS - 1)}…` : line.text;
  }

  /** A line and where it points, as one motion of Clipa (the target is set first, so the bubble opens beside it). */
  private show(line: ConductorLine | null, target: Target | null | undefined, cueId: string | null): void {
    if (target !== undefined) {
      this.targetCueId = target === null ? null : cueId;
      this.store.set({ target });
    }
    this.store.set({ line });
    this.host.present(this.bubbleText(line), target, line?.kind);
  }

  private setLine(line: ConductorLine | null): void {
    this.store.set({ line });
    this.host.present(this.bubbleText(line), undefined);
  }

  private setTarget(target: Target | null, cueId: string | null): void {
    this.targetCueId = target === null ? null : cueId;
    this.store.set({ target });
    this.host.present(null, target);
  }

  private setRegions(regions: Region[], cueId: string | null): void {
    this.store.set({ regions, regionsCueId: regions.length > 0 ? cueId : null });
  }

  /** Speaks a cue; returns 'speaking', or the outcome when it cannot be spoken. */
  private speakCue(cueId: string, text: string, maxChars?: number): 'speaking' | 'no_voice' {
    if (!this.host.speak(text, maxChars)) return 'no_voice';
    const previous = this.speaking;
    if (previous !== null) this.finish(previous.cueId, 'interrupted');
    const timer = this.host.timers.setTimeout(() => {
      if (this.speaking?.cueId === cueId && !this.speaking.started) this.finish(cueId, 'skipped');
    }, SPEECH_START_TIMEOUT_MS);
    this.speaking = { cueId, started: false, timer };
    return 'speaking';
  }

  /** The voice agent started (true) or stopped (false) speaking. */
  onAgentSpeaking(active: boolean): void {
    const s = this.speaking;
    if (s === null) return;
    if (active && !s.started) {
      s.started = true;
      if (s.timer !== null) this.host.timers.clearTimeout(s.timer);
      const cueId = s.cueId;
      s.timer = this.host.timers.setTimeout(() => { if (this.speaking?.cueId === cueId) this.finish(cueId, 'spoken'); }, SPEECH_MAX_MS);
    } else if (!active && s.started) {
      this.finish(s.cueId, 'spoken');
    }
  }

  /** Off the record or the end of the page: whatever is on screen goes, and a cue being spoken is reported interrupted. */
  clear(): void {
    if (this.speaking !== null) this.finish(this.speaking.cueId, 'interrupted');
    this.store.set({ thought: null });
    this.setRegions([], null);
    this.show(null, null, null);
    this.host.guide(null);
  }

  onCue(env: CueEnvelope): void {
    const { cue } = env;
    if (this.latest === null || env.atMs >= this.latest.atMs) this.latest = { atMs: env.atMs, localMs: this.host.now() };
    if (this.store.getState().paused) {
      // Off the record: only Clipa going out of sight is rendered.
      if (cue.type === 'state' && cue.clipa === 'hidden') { this.store.set({ pose: 'hidden' }); this.host.pose('hidden'); }
      return;
    }
    if (env.seq <= this.historyUntil) {
      if (cue.type === 'map') this.store.set({ map: { version: cue.version, map: cue.map, confirmed: cue.confirmed } });
      if (cue.type === 'teachback') this.store.set({ teachBack: { version: cue.version, text: cue.text, cueId: env.cueId } });
      return;
    }
    const now = this.conductorNow();
    const expired = env.expiresAtMs !== null && now !== null && now > env.expiresAtMs;
    switch (cue.type) {
      case 'state':
        this.store.set({ pose: cue.clipa });
        this.host.pose(cue.clipa);
        return;
      case 'context':
        this.host.context(cue.text);
        return;
      case 'map':
        this.store.set({ map: { version: cue.version, map: cue.map, confirmed: cue.confirmed } });
        return;
      case 'quiet':
        this.store.set({ quiet: cue.reason });
        this.host.log('QUIET', cue.reason);
        return;
      case 'cancel':
        this.cancel(cue.cueId);
        return;
      case 'presence':
      case 'open_web':
        // macOS only: the web has its own page for every stage.
        return;
      case 'thought': {
        // Visual only: the bubble beside Clipa shows it for THOUGHT_MS; nothing is spoken or reported.
        const thought = { cueId: env.cueId, text: cue.text };
        this.store.set({ thought });
        if (this.thoughtTimer !== null) this.host.timers.clearTimeout(this.thoughtTimer);
        this.thoughtTimer = this.host.timers.setTimeout(() => {
          this.thoughtTimer = null;
          if (this.store.getState().thought === thought) this.store.set({ thought: null });
        }, THOUGHT_MS);
        return;
      }
      case 'stage':
        this.host.stage?.(cue.mode);
        return;
      case 'attention': {
        // She flashes; a target she is not already at is pointed at the way a `point` cue does it.
        const current = this.store.getState().target;
        const there = cue.target !== null && current !== null && clipaHint(current) === clipaHint(cue.target);
        if (cue.target !== null && !there) this.setTarget(cue.target, env.cueId);
        this.host.attention?.(cue.target);
        return;
      }
      default:
        break;
    }
    if (expired) { this.finish(env.cueId, 'skipped'); return; }
    switch (cue.type) {
      case 'guide': {
        if (cue.target?.kind === 'region') this.setRegions([{ regionId: cue.target.regionId, label: cue.target.label, box: cue.target.box, evidenceId: cue.target.evidenceId }], env.cueId);
        // The rail marks the stage the step belongs to as next (and answers `mode_tab`), then Clipa says the line beside its target.
        this.host.guide({ phase: cue.phase, step: cue.step, text: cue.text });
        this.show({ cueId: env.cueId, kind: 'guide', text: cue.text, step: cue.step || null }, cue.target, env.cueId);
        if (cue.speak && !this.host.personBusy() && this.speakCue(env.cueId, cue.text) === 'speaking') return;
        this.finish(env.cueId, 'shown');
        return;
      }
      case 'ask':
      case 'warn': {
        this.remember(env.cueId, cue.type, cue.text, env.atMs);
        if (this.host.personBusy()) { this.finish(env.cueId, 'skipped'); return; }
        const withBox = cue.regions.filter((r) => r.box !== null);
        this.setRegions(withBox, env.cueId);
        const first = withBox[0] ?? null;
        this.show({ cueId: env.cueId, kind: cue.type, text: cue.text, step: null }, first === null ? null : { kind: 'region', ...first }, env.cueId);
        // After the motion has started: the warning pose then belongs to it instead of a warning in place.
        if (cue.type === 'warn') { this.store.set({ pose: 'warn' }); this.host.pose('warn'); }
        if (this.speakCue(env.cueId, cue.text) === 'no_voice') this.finish(env.cueId, 'shown');
        return;
      }
      case 'say': {
        this.remember(env.cueId, 'say', cue.text, env.atMs);
        if (this.host.personBusy()) { this.finish(env.cueId, 'skipped'); return; }
        this.setLine({ cueId: env.cueId, kind: 'say', text: cue.text, step: null });
        if (this.speakCue(env.cueId, cue.text) === 'no_voice') this.finish(env.cueId, 'shown');
        return;
      }
      case 'teachback': {
        // The teach-back is kept for the Review view even when it cannot be read aloud now.
        this.store.set({ teachBack: { version: cue.version, text: cue.text, cueId: env.cueId } });
        if (this.host.personBusy()) { this.finish(env.cueId, 'skipped'); return; }
        this.setLine({ cueId: env.cueId, kind: 'teachback', text: cue.text, step: null });
        if (this.speakCue(env.cueId, cue.text, TEACHBACK_MAX_CHARS) === 'no_voice') this.finish(env.cueId, 'shown');
        return;
      }
      case 'point': {
        this.setTarget(cue.target, env.cueId);
        if (cue.target.kind === 'region') {
          this.setRegions([{ regionId: cue.target.regionId, label: cue.target.label, box: cue.target.box, evidenceId: cue.target.evidenceId }], env.cueId);
        }
        this.finish(env.cueId, 'shown');
        return;
      }
      default:
        return;
    }
  }

  private cancel(cueId: string): void {
    const s = this.store.getState();
    if (s.regionsCueId === cueId) this.setRegions([], null);
    const line = s.line?.cueId === cueId;
    const target = this.targetCueId === cueId;
    if (line && target) this.show(null, null, null);
    else if (line) this.setLine(null);
    else if (target) this.setTarget(null, null);
    if (this.speaking?.cueId === cueId) this.finish(cueId, 'interrupted');
  }
}
