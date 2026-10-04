// What the conductor's cues put on the page: Clipa's line and pose, the regions she points at on the screen preview, the
// Work Map and the teach-back of Review. A small external store (useSyncExternalStore) next to the shell's own: the shell
// state stays the in-browser brain's, and this one is the conductor's. Nothing secret is kept here.
import type { ScreenObservation } from '@apprentice/contracts';
import type { ConductorStatus } from './client.ts';
import type { ClipaPose, MapOrigin, Region, Target } from './protocol.ts';

export interface ConductorLine {
  cueId: string;
  kind: 'guide' | 'ask' | 'warn' | 'say' | 'teachback';
  text: string;
  /** The journey step of a guide line. */
  step: string | null;
}

/** A line Clipa asked or said (ask, warn, say), newest last, with how it ended. */
export interface SaidItem {
  cueId: string;
  kind: 'ask' | 'warn' | 'say';
  text: string;
  /** Session time of the cue (ms since the conductor's epoch). */
  atMs: number;
  outcome: 'pending' | 'spoken' | 'shown' | 'skipped' | 'interrupted';
}

export interface ConductorMapSnapshot {
  version: number;
  /** The conductor's generic map (steps, guardrails, gaps, teachBack, comments) as sent; read it with fromGenericMap. */
  map: unknown;
  confirmed: boolean;
  /** Where the map comes from: this session (default), an earlier session, or the synthetic demo map. */
  origin?: MapOrigin;
}

export interface ConductorState {
  /** false until a conductor session exists for this page (then the conductor leads and the brain is the fallback). */
  enabled: boolean;
  status: ConductorStatus;
  statusDetail: string | null;
  /** The session joined from a macOS hand-over (`?join=`), or false. */
  linked: boolean;
  pose: ClipaPose | null;
  line: ConductorLine | null;
  /** Where Clipa points: a UI element or a region; null nowhere. */
  target: Target | null;
  /** Regions to outline over the live screen preview (normalised 0..1 to the frame). */
  regions: Region[];
  /** The cue the regions belong to: a cancel of that cue clears them. */
  regionsCueId: string | null;
  map: ConductorMapSnapshot | null;
  teachBack: { version: number; text: string; cueId: string } | null;
  /** Rendering is paused (off the record): cues are not shown or spoken. */
  paused: boolean;
  /** The conductor's latest reason to stay quiet (debug only). */
  quiet: string | null;
  /** The screen observations this page received (newest last), for the Review board's keyframes. */
  observations: readonly ScreenObservation[];
  /** What Clipa asked, warned or said in this page (newest last, capped). */
  said: readonly SaidItem[];
  /** The latest thought bubble, or null. Visual only: it is never spoken. */
  thought: ConductorThought | null;
}

export const MAX_SAID = 40;

/** Clipa's current thought bubble (the conductor's `thought` cue): shown beside her, faded out by CSS after a few seconds. */
export interface ConductorThought { cueId: string; text: string }

export function initialConductorState(): ConductorState {
  return {
    enabled: false, status: 'idle', statusDetail: null, linked: false, pose: null, line: null, target: null,
    regions: [], regionsCueId: null, map: null, teachBack: null, paused: false, quiet: null, observations: [], said: [], thought: null,
  };
}

export interface ConductorStore {
  getState(): ConductorState;
  set(patch: Partial<ConductorState>): void;
  subscribe(listener: () => void): () => void;
}

export function createConductorStore(): ConductorStore {
  let state = initialConductorState();
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    set(patch) {
      let changed = false;
      for (const [k, v] of Object.entries(patch)) {
        if ((state as unknown as Record<string, unknown>)[k] !== v) { changed = true; break; }
      }
      if (!changed) return;
      state = { ...state, ...patch };
      for (const l of [...listeners]) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
