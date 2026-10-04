// Clipa, redrawn for video. The shapes and colours follow the web component in
// apps/web/features/agent/clipa (a teal wire paperclip, a pale face plate, two dot eyes, no
// eyebrows). That component is left untouched; this one only re-uses its drawing as plain SVG so
// a frame can be rendered from props.
import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { color } from '../theme';

// SVG user units: a round head loop (centre 60,48, radius 30), a smaller bend at the bottom
// right and two soft ends. The lower 42 units of the left leg are a separate arm that pivots at
// the shoulder (30,60).
const BODY = 'M66 84V98A12 12 0 0 0 90 98V48A30 30 0 0 0 30 48V60';
const ARM = 'M0 0V42';

export type Mouth = 'smile' | 'grin' | 'talk' | 'flat';

export type ClipaProps = {
  /** Height in px. */
  height?: number;
  /** Arm angle in degrees: 0 hangs down, about 140 is raised for a wave. */
  armAngle?: number;
  mouth?: Mouth;
  /** Eye direction, -1 (left) to 1 (right). */
  lookX?: number;
  /** Soft shadow ellipse under the character. */
  shadow?: boolean;
  style?: React.CSSProperties;
};

const Wire: React.FC<{
  stroke: string;
  width: number;
  dx: number;
  dy: number;
  bulb: number;
  armAngle: number;
}> = ({ stroke, width, dx, dy, bulb, armAngle }) => (
  <g
    transform={`translate(${dx} ${dy})`}
    fill="none"
    stroke={stroke}
    strokeWidth={width}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d={BODY} />
    <g transform={`translate(30 60) rotate(${armAngle})`}>
      <path d={ARM} />
      {bulb > 0 ? <circle cx={0} cy={42} r={bulb} fill={stroke} stroke="none" /> : null}
    </g>
  </g>
);

const Eye: React.FC<{ x: number; look: number; blink: number }> = ({ x, look, blink }) => (
  <g transform={`translate(${x + look * 2} 47) scale(1 ${blink})`}>
    <circle r={4.3} fill={color.ink} />
    <circle cx={1.4} cy={-1.5} r={1.25} fill="#ffffff" opacity={0.9} />
  </g>
);

const MouthShape: React.FC<{ kind: Mouth; talk: number }> = ({ kind, talk }) => {
  const stroke = { fill: 'none', stroke: color.ink, strokeWidth: 2.8, strokeLinecap: 'round' as const };
  if (kind === 'grin') {
    return (
      <path
        d="M-6-2.2Q0 7.2 6-2.2Z"
        fill={color.ink}
        stroke={color.ink}
        strokeWidth={1.4}
        strokeLinejoin="round"
      />
    );
  }
  if (kind === 'talk') return <ellipse rx={4.2} ry={1.2 + 2.6 * talk} fill={color.ink} />;
  if (kind === 'flat') return <path d="M-4.2 0.4H4.2" {...stroke} />;
  return <path d="M-5.2-1.4Q0 3.8 5.2-1.4" {...stroke} />;
};

export const Clipa: React.FC<ClipaProps> = ({
  height = 400,
  armAngle = 0,
  mouth = 'smile',
  lookX = 0,
  shadow = false,
  style,
}) => {
  const frame = useCurrentFrame();
  // A blink about every 3.3 s at 30 fps, lasting 5 frames.
  const phase = frame % 100;
  const blink = phase >= 92 && phase < 97 ? 0.12 : 1;
  const talk = (Math.sin(frame * 0.9) + 1) / 2;
  const width = (height * 120) / 124;

  return (
    <svg
      viewBox="-10 0 120 124"
      width={width}
      height={height}
      style={{ overflow: 'visible', display: 'block', ...style }}
      aria-hidden="true"
    >
      {shadow ? <ellipse cx={60} cy={118} rx={30} ry={4} fill="#000" opacity={0.18} /> : null}
      <circle cx={60} cy={48} r={25} fill={color.plate} />
      <Wire stroke={color.deep} width={15.6} dx={0} dy={0} bulb={9} armAngle={armAngle} />
      <Wire stroke={color.teal} width={12} dx={0} dy={0} bulb={7.2} armAngle={armAngle} />
      <Wire stroke={color.tealDark} width={5} dx={1.6} dy={1.8} bulb={0} armAngle={armAngle} />
      <Wire stroke={color.tealLight} width={2.8} dx={-2.2} dy={-2.2} bulb={0} armAngle={armAngle} />
      <g fill={color.cheek} opacity={0.3}>
        <ellipse cx={43.5} cy={57} rx={4.2} ry={2.5} />
        <ellipse cx={76.5} cy={57} rx={4.2} ry={2.5} />
      </g>
      <Eye x={49.5} look={lookX} blink={blink} />
      <Eye x={70.5} look={lookX} blink={blink} />
      <g transform="translate(60 59.5)">
        <MouthShape kind={mouth} talk={talk} />
      </g>
    </svg>
  );
};

/** Arm angle for a wave that starts at `fromFrame`: the arm rises, then swings. */
export const useWaveAngle = (fromFrame: number, toFrame: number = Number.POSITIVE_INFINITY): number => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < fromFrame) return 0;
  const rise = spring({ frame: frame - fromFrame, fps, config: { damping: 14, stiffness: 120 } });
  const fall = Number.isFinite(toFrame)
    ? spring({ frame: frame - toFrame, fps, config: { damping: 20 } })
    : 0;
  const swing = Math.sin((frame - fromFrame) * 0.45) * 13;
  const raised = 142 * rise * (1 - fall);
  return raised + swing * rise * (1 - fall);
};

/** Gentle up and down float, in px. */
export const useBob = (amplitude = 8, period = 36): number => {
  const frame = useCurrentFrame();
  return interpolate(Math.sin((frame / period) * Math.PI * 2), [-1, 1], [-amplitude, amplitude]);
};
