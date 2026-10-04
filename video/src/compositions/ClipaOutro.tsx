import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { NightBackdrop } from '../components/Backdrop';
import { Clipa, useBob, useWaveAngle } from '../components/Clipa';
import type { ClipaOutroScript } from '../script';
import { color, font } from '../theme';

const useEnter = (delayFrames: number): number => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - delayFrames, fps, config: { damping: 18, stiffness: 110 } });
};

const Reveal: React.FC<{ delay: number; dx?: number; style?: React.CSSProperties; children: React.ReactNode }> = ({
  delay,
  dx = 0,
  style,
  children,
}) => {
  const p = useEnter(delay);
  return <div style={{ opacity: p, transform: `translateX(${(1 - p) * dx}px)`, ...style }}>{children}</div>;
};

/** Closing card: headline, short lines, links and an honesty note. Clipa rises and waves goodbye. */
export const ClipaOutro: React.FC<ClipaOutroScript> = ({ headline, lines = [], links = [], note }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const headlineIn = useEnter(4);
  const rise = spring({ frame: frame - 6, fps, config: { damping: 14, stiffness: 80 } });
  const bob = useBob(6, 40);
  const arm = useWaveAngle(Math.round(0.8 * fps));

  return (
    <NightBackdrop>
      <AbsoluteFill style={{ fontFamily: font.sans, padding: '0 140px', justifyContent: 'center' }}>
        <div
          style={{
            color: '#ffffff',
            fontSize: 100,
            fontWeight: 800,
            letterSpacing: '-0.03em',
            lineHeight: 1.05,
            maxWidth: 1300,
            opacity: headlineIn,
            transform: `translateY(${(1 - headlineIn) * 40}px)`,
          }}
        >
          {headline}
        </div>
        <div style={{ marginTop: 34, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {lines.map((text, i) => (
            <Reveal key={i} delay={14 + i * 6} dx={-30} style={{ color: color.tealLight, fontSize: 44, fontWeight: 500 }}>
              {text}
            </Reveal>
          ))}
        </div>
        <div style={{ marginTop: 44, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {links.map((link, i) => (
            <Reveal key={i} delay={26 + i * 6} style={{ display: 'flex', alignItems: 'baseline', gap: 22 }}>
                <span
                  style={{
                    minWidth: 150,
                    padding: '6px 20px',
                    borderRadius: 999,
                    background: color.teal,
                    color: color.night,
                    fontSize: 26,
                    fontWeight: 700,
                    textAlign: 'center',
                  }}
                >
                  {link.label}
                </span>
                <span style={{ color: '#ffffff', fontFamily: font.mono, fontSize: 32, fontWeight: 500 }}>{link.url}</span>
            </Reveal>
          ))}
        </div>
        {note ? (
          <div style={{ marginTop: 52, color: '#b7c9c5', fontSize: 28, fontWeight: 500, maxWidth: 1200 }}>{note}</div>
        ) : null}
      </AbsoluteFill>
      <div
        style={{
          position: 'absolute',
          right: 150,
          bottom: 70 - bob,
          opacity: interpolate(rise, [0, 0.4], [0, 1], { extrapolateRight: 'clamp' }),
          transform: `translateY(${(1 - rise) * 260}px)`,
        }}
      >
        <Clipa height={520} armAngle={arm} mouth="grin" shadow lookX={-0.3} />
      </div>
    </NightBackdrop>
  );
};
