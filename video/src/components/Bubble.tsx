import React from 'react';
import { spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { color, font } from '../theme';

/** A speech bubble that pops in at `fromFrame`. The tail points left, toward Clipa. */
export const Bubble: React.FC<{
  fromFrame: number;
  fontSize?: number;
  weight?: number;
  maxWidth?: number;
  tail?: 'left' | 'none';
  children: React.ReactNode;
}> = ({ fromFrame, fontSize = 56, weight = 600, maxWidth = 900, tail = 'left', children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame: frame - fromFrame, fps, config: { damping: 15, stiffness: 140 } });
  if (frame < fromFrame) return null;
  return (
    <div
      style={{
        position: 'relative',
        maxWidth,
        padding: '34px 44px',
        borderRadius: 36,
        background: color.surface,
        border: `4px solid ${color.teal}`,
        color: color.ink,
        fontFamily: font.sans,
        fontSize,
        fontWeight: weight,
        lineHeight: 1.25,
        letterSpacing: '-0.01em',
        transform: `scale(${0.85 + 0.15 * pop})`,
        transformOrigin: tail === 'left' ? 'left center' : 'center',
        opacity: Math.min(1, pop * 1.4),
        boxShadow: '0 18px 40px rgba(0,0,0,0.22)',
      }}
    >
      {tail === 'left' ? (
        <div
          style={{
            position: 'absolute',
            left: -22,
            top: '50%',
            width: 36,
            height: 36,
            marginTop: -18,
            background: color.surface,
            borderLeft: `4px solid ${color.teal}`,
            borderBottom: `4px solid ${color.teal}`,
            transform: 'rotate(45deg)',
          }}
        />
      ) : null}
      {children}
    </div>
  );
};
