import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { color } from '../theme';

/** Deep teal background with two slow soft circles. Used by the title, intro and outro. */
export const NightBackdrop: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const frame = useCurrentFrame();
  const drift = interpolate(frame, [0, 600], [0, 60], { extrapolateRight: 'extend' });
  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(135deg, ${color.night} 0%, ${color.night2} 55%, #0b4a45 100%)`,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          width: 1100,
          height: 1100,
          right: -300 + drift,
          top: -420,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${color.teal}55 0%, ${color.teal}00 68%)`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: 900,
          height: 900,
          left: -380 - drift / 2,
          bottom: -520,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${color.tealLight}22 0%, ${color.tealLight}00 70%)`,
        }}
      />
      {children}
    </AbsoluteFill>
  );
};
