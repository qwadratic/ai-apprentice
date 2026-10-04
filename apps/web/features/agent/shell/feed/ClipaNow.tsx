import { useConductor, useConductorLeads } from '../conductor/hooks.ts';
import type { ClipaPose } from '../conductor/protocol.ts';
import { useShellState } from '../hooks.ts';
import type { ShellState } from '../state/types.ts';

const POSE_WORD: Record<ClipaPose, string> = {
  idle: 'watching',
  listen: 'listening',
  think: 'thinking',
  speak: 'speaking',
  point: 'pointing',
  warn: 'warning',
  celebrate: 'pleased',
  retreat: 'resting',
  hidden: 'resting',
};

const VOICE_WORD: Record<ShellState['voice']['phase'], string> = {
  idle: 'ready',
  connecting: 'connecting',
  listening: 'listening',
  speaking: 'speaking',
  offline: 'voice offline',
  ended: 'done',
};

/** Clipa's state in one word, and her tone for the card (calm, speaking, warning, off). */
function useClipaState(): { word: string; tone: 'calm' | 'speak' | 'warn' | 'off' } {
  const leads = useConductorLeads();
  const status = useConductor((s) => s.status);
  const pose = useConductor((s) => s.pose);
  const offRecord = useShellState((s) => s.offRecord);
  const voice = useShellState((s) => s.voice.phase);
  const warned = useShellState((s) => s.teach.checkpoint?.status === 'warn');
  if (offRecord) return { word: 'off the record', tone: 'off' };
  if (leads && (status === 'connecting' || status === 'retrying' || status === 'idle')) return { word: 'connecting', tone: 'calm' };
  if (leads && pose !== null) return { word: POSE_WORD[pose], tone: pose === 'warn' ? 'warn' : pose === 'speak' ? 'speak' : 'calm' };
  if (warned) return { word: 'warning', tone: 'warn' };
  return { word: VOICE_WORD[voice], tone: voice === 'speaking' ? 'speak' : 'calm' };
}

/**
 * What Clipa is saying now, large: the conductor's current line while it leads, else the question the in-browser brain asked
 * last. `idle` is the one line that says what to do next when she has nothing to say.
 */
export function ClipaNow({ idle }: { idle: string }) {
  const leads = useConductorLeads();
  const line = useConductor((s) => s.line);
  const linked = useConductor((s) => s.linked);
  const offRecord = useShellState((s) => s.offRecord);
  const asked = useShellState((s) => {
    for (let i = s.feed.length - 1; i >= 0; i -= 1) if (s.feed[i]!.status === 'asked') return s.feed[i]!.text;
    return null;
  });
  const { word, tone } = useClipaState();
  const text = offRecord ? null : leads ? (line?.text ?? null) : asked;
  const kind = offRecord ? 'off' : leads ? (line?.kind ?? 'idle') : asked !== null ? 'ask' : 'idle';

  return (
    <section className="as-now" aria-label="Clipa now" data-testid="clipa-now" data-tone={tone} data-kind={kind}>
      <div className="as-now__who">
        <span className="as-now__dot" aria-hidden="true" />
        <span className="as-now__name">Clipa</span>
        <span className="as-now__state">{word}</span>
        {linked && <span className="as-tag as-tag--accent">joined from the Mac</span>}
      </div>
      <p className={`as-now__line${text === null ? ' as-now__line--idle' : ''}`} role="status" aria-live="polite">
        {offRecord ? 'Off the record: I am not watching or listening. Press Back on record to go on.' : (text ?? idle)}
      </p>
    </section>
  );
}
