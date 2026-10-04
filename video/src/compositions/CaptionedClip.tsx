import React from 'react';
import {
  AbsoluteFill,
  interpolate,
  OffthreadVideo,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type { CaptionedClipScript, HighlightScript } from '../script';
import { color, font } from '../theme';

const isUrl = (src: string): boolean => /^https?:\/\//i.test(src);

/** Opacity ramp over `ramp` frames at both ends of [from, to]. */
const fadeWindow = (frame: number, from: number, to: number, ramp = 6): number =>
  interpolate(frame, [from, from + ramp, to - ramp, to], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

const Highlight: React.FC<{ h: HighlightScript }> = ({ h }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const from = h.fromSec * fps;
  const to = h.toSec * fps;
  if (frame < from || frame > to) return null;
  const visible = fadeWindow(frame, from, to, 8);
  const pulse = 0.5 + 0.5 * Math.sin((frame - from) * 0.25);
  const grow = interpolate(frame, [from, from + 10], [1.06, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <div
      style={{
        position: 'absolute',
        left: `${h.x * 100}%`,
        top: `${h.y * 100}%`,
        width: `${h.w * 100}%`,
        height: `${h.h * 100}%`,
        border: `6px solid ${color.amber}`,
        borderRadius: 14,
        boxShadow: `0 0 0 ${4 + pulse * 6}px ${color.amber}33, 0 10px 30px rgba(0,0,0,0.25)`,
        opacity: visible,
        transform: `scale(${grow})`,
        transformOrigin: 'center',
      }}
    >
      {h.label ? (
        <div
          style={{
            position: 'absolute',
            left: -6,
            top: -58,
            padding: '8px 20px',
            borderRadius: 12,
            background: color.amber,
            color: '#2a1a00',
            fontFamily: font.sans,
            fontSize: 28,
            fontWeight: 700,
            whiteSpace: 'nowrap',
          }}
        >
          {h.label}
        </div>
      ) : null}
    </div>
  );
};

const Pill: React.FC<{ children: React.ReactNode; tone: 'teal' | 'amber'; style?: React.CSSProperties }> = ({
  children,
  tone,
  style,
}) => (
  <div
    style={{
      padding: '8px 22px',
      borderRadius: 999,
      fontFamily: font.sans,
      fontSize: 26,
      fontWeight: 600,
      background: tone === 'teal' ? color.teal : '#3a2a08',
      color: tone === 'teal' ? color.night : '#ffd98a',
      border: tone === 'teal' ? 'none' : `2px solid ${color.amber}`,
      whiteSpace: 'nowrap',
      ...style,
    }}
  >
    {children}
  </div>
);

export const CaptionedClip: React.FC<CaptionedClipScript> = ({
  src,
  startFromSec = 0,
  playbackRate = 1,
  layout = 'framed',
  heading,
  badge,
  captions,
  highlights = [],
  zoom = [],
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const full = layout === 'full';

  const boxWidth = full ? width : 1500;
  const boxHeight = full ? height : Math.round((boxWidth * 9) / 16);
  const boxLeft = (width - boxWidth) / 2;
  const boxTop = full ? 0 : 92;

  const t = frame / fps;
  const active = captions.find((c) => t >= c.fromSec && t < c.toSec);
  // The zoom: the active window's scale and origin, eased in and out over 0.6 s.
  const z = zoom.find((w) => t >= w.fromSec - 0.6 && t < w.toSec + 0.6);
  const zoomIn = z
    ? Math.min(
        interpolate(t, [z.fromSec - 0.6, z.fromSec], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
        interpolate(t, [z.toSec, z.toSec + 0.6], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
      )
    : 0;
  const ease = zoomIn < 0.5 ? 2 * zoomIn * zoomIn : 1 - Math.pow(-2 * zoomIn + 2, 2) / 2;
  const scale = z ? 1 + (z.scale - 1) * ease : 1;
  const origin = z ? `${z.x * 100}% ${z.y * 100}%` : '50% 50%';
  const captionOpacity = active ? fadeWindow(frame, active.fromSec * fps, active.toSec * fps, 6) : 0;

  return (
    <AbsoluteFill style={{ background: full ? '#000' : `linear-gradient(160deg, ${color.night} 0%, ${color.night2} 100%)` }}>
      <div
        style={{
          position: 'absolute',
          left: boxLeft,
          top: boxTop,
          width: boxWidth,
          height: boxHeight,
          borderRadius: full ? 0 : 22,
          overflow: 'hidden',
          background: '#fff',
          boxShadow: full ? undefined : '0 30px 80px rgba(0,0,0,0.5), 0 0 0 2px #ffffff22',
        }}
      >
        <div style={{ position: 'absolute', inset: 0, transform: `scale(${scale})`, transformOrigin: origin }}>
          <OffthreadVideo
            src={isUrl(src) ? src : staticFile(src)}
            trimBefore={Math.round(startFromSec * fps)}
            playbackRate={playbackRate}
            muted
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
          <div style={{ position: 'absolute', inset: 0 }}>
            {highlights.map((h, i) => (
              <Highlight key={i} h={h} />
            ))}
          </div>
        </div>
      </div>

      {heading ? (
        <Pill tone="teal" style={{ position: 'absolute', left: boxLeft, top: full ? 30 : 22 }}>
          {heading}
        </Pill>
      ) : null}
      {badge ? (
        <Pill
          tone="amber"
          style={{ position: 'absolute', right: boxLeft, top: full ? 30 : 22 }}
        >
          {badge}
        </Pill>
      ) : null}

      {active ? (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: full ? 56 : 30,
            display: 'flex',
            justifyContent: 'center',
            opacity: captionOpacity,
            transform: `translateY(${(1 - captionOpacity) * 14}px)`,
          }}
        >
          <div
            style={{
              maxWidth: 1560,
              padding: '16px 40px',
              borderRadius: 18,
              background: 'rgba(10, 31, 29, 0.92)',
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
      ) : null}
    </AbsoluteFill>
  );
};
