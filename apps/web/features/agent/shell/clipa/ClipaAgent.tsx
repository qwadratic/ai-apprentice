import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { DetailedHTMLProps, HTMLAttributes } from 'react';
import './clipa.ts';
import { useShell } from '../hooks.ts';
import type { PointDirection } from './presenter.ts';
import { pointDirection } from './presenter.ts';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'clipa-buddy': DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        state?: string;
        size?: string | number;
        point?: string;
        off?: boolean | string;
      };
    }
  }
}

const LABELS = {
  idle: 'Idle',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  warning: 'Warning',
  happy: 'Happy',
  pointing: 'Pointing',
  off: 'Off the record',
} as const;

/**
 * The default Clipa view: the web component, a state label and the speech bubble with the current question.
 * It renders whatever the ClipaPresenter store holds. A motion director (TASK-3.28) can replace this component.
 */
export function ClipaAgent() {
  const { clipa } = useShell();
  const snapshot = useSyncExternalStore(clipa.subscribe, clipa.getSnapshot, clipa.getSnapshot);
  const ref = useRef<HTMLElement | null>(null);
  const [point, setPoint] = useState<PointDirection>('left');
  const { state, bubble, target } = snapshot;

  // While pointing at a target, face it. Without a target the arm points toward the workspace on the left.
  useLayoutEffect(() => {
    const el = ref.current;
    if (state !== 'pointing' || !el) return;
    if (!target) { setPoint('left'); return; }
    const box = el.getBoundingClientRect();
    setPoint(pointDirection({ x: box.x, y: box.y, width: box.width, height: box.height }, target));
  }, [state, target]);

  const off = state === 'off';
  return (
    <div className="as-clipa" data-state={state}>
      <clipa-buddy
        ref={ref}
        state={off ? 'idle' : state}
        point={point}
        size="104"
        off={off}
      />
      <div className="as-clipa__side">
        <p className="as-clipa__state" role="status">
          <span className="as-clipa__label">Clipa</span> {LABELS[state]}
        </p>
        {bubble !== '' && (
          <p className="as-bubble" role="status" aria-live="polite" data-testid="clipa-bubble">{bubble}</p>
        )}
      </div>
    </div>
  );
}
