import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { NightBackdrop } from '../components/Backdrop';
import type { ArchitectureScript, ArchEdgeScript, CaptionScript } from '../script';
import { color, font } from '../theme';

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

const useEnter = (atSec: number): number => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - atSec * fps, fps, config: { damping: 18, stiffness: 120 } });
};

const Group: React.FC<{ x: number; y: number; w: number; h: number; label: string; atSec: number }> = ({ x, y, w, h, label, atSec }) => {
  const enter = useEnter(atSec);
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: w,
        height: h,
        borderRadius: 30,
        border: `3px dashed ${color.tealLight}66`,
        background: '#ffffff08',
        opacity: enter,
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: 24,
          top: -22,
          padding: '4px 16px',
          borderRadius: 999,
          background: color.night2,
          color: color.tealLight,
          fontFamily: font.mono,
          fontSize: 24,
          fontWeight: 700,
        }}
      >
        {label}
      </div>
    </div>
  );
};

const Node: React.FC<ArchitectureScript['nodes'][number]> = ({ x, y, w, h, title, sub, atSec, tone = 'plain' }) => {
  const enter = useEnter(atSec);
  const accent = tone === 'amber' ? color.amber : color.teal;
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: w,
        height: h,
        boxSizing: 'border-box',
        padding: '18px 22px',
        borderRadius: 22,
        background: tone === 'plain' ? color.surface : '#ffffff',
        borderTop: `8px solid ${accent}`,
        boxShadow: '0 14px 34px rgba(0,0,0,0.35)',
        opacity: enter,
        transform: `translateY(${(1 - enter) * 30}px)`,
        fontFamily: font.sans,
        color: color.ink,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 8,
      }}
    >
      <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: '-0.01em', lineHeight: 1.1 }}>{title}</div>
      {sub ? <div style={{ fontSize: 22, fontWeight: 500, color: color.muted, lineHeight: 1.3 }}>{sub}</div> : null}
    </div>
  );
};

const Edge: React.FC<{ edge: ArchEdgeScript; index: number }> = ({ edge, index }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const points = [edge.from, ...(edge.via ?? []), edge.to];
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0]} ${p[1]}`).join(' ');
  const length = points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - (points[i]?.[0] ?? p[0]), p[1] - (points[i]?.[1] ?? p[1])), 0);
  const draw = interpolate(frame, [edge.atSec * fps, edge.atSec * fps + 18], [0, 1], clamp);
  const marker = `url(#arrow-${index})`;
  const stroke = edge.tone === 'amber' ? color.amber : color.tealLight;
  return (
    <g opacity={draw > 0 ? 1 : 0}>
      <defs>
        <marker id={`arrow-${index}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={stroke} />
        </marker>
      </defs>
      <path
        d={d}
        fill="none"
        stroke={stroke}
        strokeWidth={6}
        strokeLinejoin="round"
        strokeDasharray={length}
        strokeDashoffset={length * (1 - draw)}
        markerEnd={draw > 0.95 ? marker : undefined}
        markerStart={edge.both && draw > 0.95 ? marker : undefined}
      />
      {edge.label && edge.labelAt ? (
        <foreignObject x={edge.labelAt[0] - 300} y={edge.labelAt[1] - 24} width={600} height={56} opacity={draw}>
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <span
              style={{
                padding: '4px 14px',
                borderRadius: 12,
                background: color.night,
                color: edge.tone === 'amber' ? color.amber : color.tealLight,
                fontFamily: font.mono,
                fontSize: 22,
                fontWeight: 700,
                whiteSpace: 'nowrap',
              }}
            >
              {edge.label}
            </span>
          </div>
        </foreignObject>
      ) : null}
    </g>
  );
};

/** Timed captions in the same style as CaptionedClip, for scenes without a clip. */
export const SceneCaption: React.FC<{ captions?: CaptionScript[] }> = ({ captions = [] }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const active = captions.find((c) => t >= c.fromSec && t < c.toSec);
  if (!active) return null;
  const opacity = Math.min(
    interpolate(frame, [active.fromSec * fps, active.fromSec * fps + 6], [0, 1], clamp),
    interpolate(frame, [active.toSec * fps - 6, active.toSec * fps], [1, 0], clamp),
  );
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 34, display: 'flex', justifyContent: 'center', opacity }}>
      <div
        style={{
          maxWidth: 1600,
          padding: '16px 40px',
          borderRadius: 18,
          background: 'rgba(10, 31, 29, 0.94)',
          borderLeft: `8px solid ${color.teal}`,
          color: '#ffffff',
          fontFamily: font.sans,
          fontSize: 42,
          fontWeight: 600,
          lineHeight: 1.25,
          textAlign: 'center',
          boxShadow: '0 10px 30px rgba(0,0,0,0.4)',
        }}
      >
        {active.text}
      </div>
    </div>
  );
};

/** A box-and-arrow diagram drawn from the script: groups, nodes and edges appear at their own times. */
export const Architecture: React.FC<ArchitectureScript> = ({ title, kicker, groups = [], nodes, edges = [], captions, footer }) => (
  <NightBackdrop>
    <div style={{ position: 'absolute', left: 60, top: 40, fontFamily: font.sans }}>
      {kicker ? (
        <div style={{ color: color.tealLight, fontSize: 26, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{kicker}</div>
      ) : null}
      <div style={{ color: '#ffffff', fontSize: 54, fontWeight: 800, letterSpacing: '-0.02em' }}>{title}</div>
    </div>
    {groups.map((g, i) => (
      <Group key={`g-${i}`} {...g} />
    ))}
    <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0 }}>
      {edges.map((e, i) => (
        <Edge key={`e-${i}`} edge={e} index={i} />
      ))}
    </svg>
    {nodes.map((n, i) => (
      <Node key={`n-${i}`} {...n} />
    ))}
    {footer ? (
      <div style={{ position: 'absolute', right: 60, top: 58, color: '#ffffffaa', fontFamily: font.sans, fontSize: 24 }}>{footer}</div>
    ) : null}
    <SceneCaption captions={captions} />
  </NightBackdrop>
);
