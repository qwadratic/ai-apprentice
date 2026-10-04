import type { ScreenState } from '@apprentice/contracts';
import type { DraftMap, GapItem } from '../brain/types.ts';
import { LIMITS } from './types.ts';
import type {
  Banner, CaptureInfo, CheckpointCard, DecisionEntry, FeedItem, FeedStatus, LogLine, MasteryState, Mode, ObservationRow,
  Persona, SessionInfo, ShellState, VoicePhase,
} from './types.ts';
import { DEFAULT_PERSONA } from './types.ts';

export function initialState(persona: Persona = DEFAULT_PERSONA): ShellState {
  return {
    mode: 'learn',
    persona,
    offRecord: false,
    phase: 'idle',
    session: null,
    voice: { phase: 'idle', thinking: false, error: null },
    screen: { sampleOn: false, source: null, state: 'none', reason: null, capture: { state: 'idle', reason: null } },
    banner: null,
    brain: { name: 'NullBrain', wired: false },
    observations: [],
    feed: [],
    draftMap: { steps: [] },
    review: { gaps: [], teachBack: { text: null, status: 'none', correction: null } },
    teach: { checkpoint: null, mastery: null },
    replay: { evidenceId: null },
    clipaHint: null,
    decisions: [],
    events: [],
    nextLogId: 1,
  };
}

export type Action =
  | { type: 'MODE_SET'; mode: Mode }
  | { type: 'PERSONA_SET'; persona: Persona }
  | { type: 'SAMPLE_SET'; on: boolean }
  | { type: 'OFF_RECORD_SET'; on: boolean }
  | { type: 'BRAIN_SET'; name: string; wired: boolean }
  | { type: 'SESSION_STARTING'; mode: Mode }
  | { type: 'SESSION_READY'; session: SessionInfo }
  | { type: 'SESSION_FAILED'; message: string }
  | { type: 'SESSION_ENDING' }
  | { type: 'SESSION_ENDED'; reason: string }
  | { type: 'CONVERSATION_BOUND'; conversationId: string }
  | { type: 'VOICE_PHASE'; phase: VoicePhase; error?: string | null }
  | { type: 'VOICE_THINKING'; thinking: boolean }
  | { type: 'SCREEN_SOURCE'; source: { label: string; synthetic: boolean } | null }
  | { type: 'SCREEN_STATUS'; state: ScreenState | 'none'; reason: string | null }
  | { type: 'CAPTURE_SNAPSHOT'; capture: CaptureInfo }
  | { type: 'BANNER_SET'; banner: Banner | null }
  | { type: 'OBSERVATION'; row: ObservationRow }
  | { type: 'DECISION'; entry: DecisionEntry }
  | { type: 'DECISION_LATENCY'; id: string; latencyMs: number }
  | { type: 'FEED_ADD'; item: FeedItem }
  | { type: 'FEED_ANSWER'; id: string; text: string; atMs: number }
  | { type: 'FEED_STATUS'; id: string; status: FeedStatus; note: string | null }
  | { type: 'CLIPA_HINT'; hint: 'warning' | 'pointing' | null }
  | { type: 'MAP_SET'; map: DraftMap }
  | { type: 'REVIEW_SET'; gaps: GapItem[]; teachBack: string | null }
  | { type: 'TEACHBACK_CONFIRM' }
  | { type: 'TEACHBACK_CORRECT'; text: string }
  | { type: 'CHECKPOINT_RESULT'; card: CheckpointCard }
  | { type: 'CHECKPOINT_DELIVERY_FAILED'; checkpointId: string; error: string }
  | { type: 'MASTERY_SET'; mastery: MasteryState | null }
  | { type: 'REPLAY_OPEN'; evidenceId: string }
  | { type: 'REPLAY_CLOSE' }
  | { type: 'LOG'; t: number; dir: LogLine['dir']; logType: string; text: string };

function capped<T>(list: readonly T[], item: T, max: number): T[] {
  const next = [...list, item];
  return next.length > max ? next.slice(next.length - max) : next;
}

function withoutError(banner: Banner | null): Banner | null {
  return banner && banner.kind === 'error' ? null : banner;
}

/** Data of one Learn run. A new Learn session starts clean; Review and Teach keep what Learn produced. */
function learnReset(state: ShellState): Partial<ShellState> {
  return {
    observations: [],
    feed: [],
    decisions: [],
    draftMap: { steps: [] },
    review: { gaps: [], teachBack: { text: null, status: 'none', correction: null } },
    teach: { checkpoint: null, mastery: null },
    replay: { evidenceId: null },
    clipaHint: null,
    banner: withoutError(state.banner),
  };
}

export function reduce(state: ShellState, action: Action): ShellState {
  switch (action.type) {
    case 'MODE_SET':
      // Switching the view never touches the session or any collected data.
      return action.mode === state.mode ? state : { ...state, mode: action.mode };
    case 'PERSONA_SET':
      return { ...state, persona: action.persona };
    case 'SAMPLE_SET':
      return { ...state, screen: { ...state.screen, sampleOn: action.on } };
    case 'OFF_RECORD_SET':
      return {
        ...state,
        offRecord: action.on,
        clipaHint: action.on ? null : state.clipaHint,
        banner: action.on ? null : state.banner,
        voice: action.on ? { ...state.voice, thinking: false } : state.voice,
      };
    case 'BRAIN_SET':
      return { ...state, brain: { name: action.name, wired: action.wired } };
    case 'SESSION_STARTING':
      return {
        ...state,
        ...(action.mode === 'learn' ? learnReset(state) : { banner: withoutError(state.banner) }),
        phase: 'starting',
        session: null,
        voice: { phase: 'idle', thinking: false, error: null },
        screen: { ...state.screen, source: null, state: 'none', reason: null },
      };
    case 'SESSION_READY':
      return { ...state, phase: 'live', session: action.session };
    case 'SESSION_FAILED':
      return { ...state, phase: 'error', session: null, banner: { kind: 'error', text: action.message } };
    case 'SESSION_ENDING':
      return { ...state, phase: 'ending' };
    case 'SESSION_ENDED':
      return {
        ...state,
        phase: 'ended',
        // The session summary stays visible (id, mode) but the cap and the voice are over.
        voice: { phase: state.voice.phase === 'offline' ? 'offline' : 'ended', thinking: false, error: state.voice.error },
        screen: { ...state.screen, source: null, state: state.screen.state === 'none' ? 'none' : 'stopped', reason: null },
        clipaHint: null,
      };
    case 'CONVERSATION_BOUND':
      return state.session ? { ...state, session: { ...state.session, conversationId: action.conversationId } } : state;
    case 'VOICE_PHASE':
      return {
        ...state,
        voice: {
          phase: action.phase,
          thinking: action.phase === 'speaking' ? false : state.voice.thinking,
          error: action.error === undefined ? state.voice.error : action.error,
        },
      };
    case 'VOICE_THINKING':
      return state.voice.thinking === action.thinking ? state : { ...state, voice: { ...state.voice, thinking: action.thinking } };
    case 'SCREEN_SOURCE':
      return { ...state, screen: { ...state.screen, source: action.source } };
    case 'SCREEN_STATUS':
      return { ...state, screen: { ...state.screen, state: action.state, reason: action.reason } };
    case 'CAPTURE_SNAPSHOT':
      return { ...state, screen: { ...state.screen, capture: action.capture } };
    case 'BANNER_SET':
      return { ...state, banner: action.banner };
    case 'OBSERVATION':
      return { ...state, observations: capped(state.observations, action.row, LIMITS.observations) };
    case 'DECISION':
      return { ...state, decisions: capped(state.decisions, action.entry, LIMITS.decisions) };
    case 'DECISION_LATENCY':
      return {
        ...state,
        decisions: state.decisions.map((d) => (d.id === action.id ? { ...d, latencyMs: action.latencyMs } : d)),
      };
    case 'FEED_ADD':
      return state.feed.some((f) => f.id === action.item.id) ? state : { ...state, feed: [...state.feed, action.item] };
    case 'FEED_ANSWER':
      return {
        ...state,
        feed: state.feed.map((f) => (f.id === action.id ? { ...f, status: 'answered', answer: { text: action.text, atMs: action.atMs } } : f)),
        clipaHint: null,
      };
    case 'FEED_STATUS':
      return { ...state, feed: state.feed.map((f) => (f.id === action.id ? { ...f, status: action.status, note: action.note } : f)) };
    case 'CLIPA_HINT':
      return state.clipaHint === action.hint ? state : { ...state, clipaHint: action.hint };
    case 'MAP_SET':
      return { ...state, draftMap: action.map };
    case 'REVIEW_SET': {
      const keepStatus = state.review.teachBack.status === 'confirmed' || state.review.teachBack.status === 'corrected';
      const sameText = state.review.teachBack.text === action.teachBack;
      return {
        ...state,
        review: {
          gaps: action.gaps,
          teachBack: keepStatus && sameText
            ? state.review.teachBack
            : { text: action.teachBack, status: action.teachBack === null ? 'none' : 'pending', correction: null },
        },
      };
    }
    case 'TEACHBACK_CONFIRM':
      return state.review.teachBack.text === null
        ? state
        : { ...state, review: { ...state.review, teachBack: { ...state.review.teachBack, status: 'confirmed', correction: null } } };
    case 'TEACHBACK_CORRECT':
      return state.review.teachBack.text === null
        ? state
        : { ...state, review: { ...state.review, teachBack: { ...state.review.teachBack, status: 'corrected', correction: action.text } } };
    case 'CHECKPOINT_RESULT':
      return { ...state, teach: { ...state.teach, checkpoint: action.card } };
    case 'CHECKPOINT_DELIVERY_FAILED':
      return state.teach.checkpoint && state.teach.checkpoint.checkpointId === action.checkpointId
        ? { ...state, teach: { ...state.teach, checkpoint: { ...state.teach.checkpoint, deliveryError: action.error } } }
        : state;
    case 'MASTERY_SET':
      return { ...state, teach: { ...state.teach, mastery: action.mastery } };
    case 'REPLAY_OPEN':
      return { ...state, replay: { evidenceId: action.evidenceId } };
    case 'REPLAY_CLOSE':
      return state.replay.evidenceId === null ? state : { ...state, replay: { evidenceId: null } };
    case 'LOG': {
      const line: LogLine = { id: state.nextLogId, t: action.t, dir: action.dir, type: action.logType, text: action.text };
      return { ...state, events: capped(state.events, line, LIMITS.events), nextLogId: state.nextLogId + 1 };
    }
  }
}
