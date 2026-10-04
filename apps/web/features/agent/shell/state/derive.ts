// Pure derivations from the shell state: what Clipa shows and what the status bar says.
import type { ClipaState } from '../clipa/presenter.ts';
import { formatClock } from '../session-clock.ts';
import type { DecisionEntry, ShellState } from './types.ts';

/**
 * Clipa follows the session state and nothing else. Mapping (TASK-3.8):
 * off the record -> off; error -> warning; replay of a moment -> pointing; Teach warn -> warning;
 * speaking, thinking, listening follow the voice; Teach clear or mastered -> happy.
 */
export function deriveClipaState(s: ShellState): ClipaState {
  if (s.offRecord) return 'off';
  if (s.banner?.kind === 'error' || s.phase === 'error') return 'warning';
  if (s.replay.evidenceId !== null) return 'pointing';
  const checkpoint = s.teach.checkpoint;
  if (checkpoint?.status === 'warn') return 'warning';
  if (s.voice.phase === 'speaking') return s.clipaHint ?? 'speaking';
  if (s.voice.thinking) return 'thinking';
  if (checkpoint?.status === 'clear' || (s.teach.mastery !== null && s.teach.mastery.practise.length === 0 && s.teach.mastery.mastered.length > 0)) {
    return 'happy';
  }
  if (s.voice.phase === 'listening') return s.clipaHint ?? 'listening';
  return 'idle';
}

export type ChipTone = 'ok' | 'warn' | 'bad' | 'off';
export interface Chip {
  label: string;
  value: string;
  tone: ChipTone;
}

const CAPTURE_TEXT: Record<ShellState['screen']['capture']['state'], string> = {
  idle: 'no screen shared',
  selecting: 'choosing a source',
  paused: 'shared, paused',
  capturing: 'shared locally, not analysed',
  stopped: 'no screen shared',
  error: 'sharing failed',
};

export function screenChip(s: ShellState): Chip {
  const src = s.screen.source;
  if (s.offRecord) return { label: 'Screen', value: 'off the record', tone: 'off' };
  if (src && s.screen.state !== 'none') {
    const tone: ChipTone = s.screen.state === 'capturing' ? 'ok' : s.screen.state === 'error' ? 'bad' : 'warn';
    const reason = s.screen.reason ? ` (${s.screen.reason})` : '';
    return { label: 'Screen', value: `${src.synthetic ? 'sample, synthetic' : 'live'}: ${s.screen.state}${reason}`, tone };
  }
  const capture = s.screen.capture;
  const tone: ChipTone = capture.state === 'capturing' ? 'warn' : capture.state === 'error' ? 'bad' : 'off';
  return { label: 'Screen', value: CAPTURE_TEXT[capture.state], tone };
}

export function voiceChip(s: ShellState): Chip {
  if (s.offRecord) return { label: 'Voice', value: 'off the record', tone: 'off' };
  switch (s.voice.phase) {
    case 'idle': return { label: 'Voice', value: s.phase === 'starting' ? 'waiting for session' : 'not started', tone: 'off' };
    case 'connecting': return { label: 'Voice', value: 'connecting', tone: 'warn' };
    case 'listening': return { label: 'Voice', value: 'live, listening', tone: 'ok' };
    case 'speaking': return { label: 'Voice', value: 'live, speaking', tone: 'ok' };
    case 'offline': return { label: 'Voice', value: 'offline', tone: 'bad' };
    case 'ended': return { label: 'Voice', value: 'ended', tone: 'off' };
  }
}

export function sessionChip(s: ShellState, nowMs: number): Chip {
  const session = s.session;
  switch (s.phase) {
    case 'idle': return { label: 'Session', value: 'none', tone: 'off' };
    case 'starting': return { label: 'Session', value: 'starting', tone: 'warn' };
    case 'live': {
      const left = session ? Math.max(0, session.deadlineMs - nowMs) : 0;
      return { label: 'Session', value: `live, ${formatClock(left)} left`, tone: 'ok' };
    }
    case 'ending': return { label: 'Session', value: 'ending', tone: 'warn' };
    case 'ended': return { label: 'Session', value: 'ended', tone: 'off' };
    case 'error': return { label: 'Session', value: 'failed to start', tone: 'bad' };
  }
}

export function recordChip(s: ShellState): Chip {
  if (s.offRecord) return { label: 'Record', value: 'off the record', tone: 'off' };
  if (s.phase === 'live') return { label: 'Record', value: 'on the record', tone: 'warn' };
  return { label: 'Record', value: 'not recording', tone: 'off' };
}

export function statusChips(s: ShellState, nowMs: number): Chip[] {
  return [screenChip(s), voiceChip(s), sessionChip(s, nowMs), recordChip(s)];
}

export interface LatencySummary {
  count: number;
  lastMs: number | null;
  medianMs: number | null;
}

/** Observation-to-audio latency over the decisions that were spoken and measured. */
export function summarizeLatency(decisions: readonly DecisionEntry[]): LatencySummary {
  const values = decisions.flatMap((d) => (d.latencyMs === null ? [] : [d.latencyMs]));
  if (values.length === 0) return { count: 0, lastMs: null, medianMs: null };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return { count: values.length, lastMs: values[values.length - 1] ?? null, medianMs: Math.round(median) };
}
