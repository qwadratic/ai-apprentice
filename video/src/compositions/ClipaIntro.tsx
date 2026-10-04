import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { NightBackdrop } from '../components/Backdrop';
import { Bubble } from '../components/Bubble';
import { Clipa, useBob, useWaveAngle } from '../components/Clipa';
import type { ClipaIntroScript } from '../script';
import { color, font } from '../theme';

/** Clipa flies in from the bottom right along an arc, lands, waves and says hello. */
export const ClipaIntro: React.FC<ClipaIntroScript> = ({ greeting, line, footer }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const fly = spring({ frame, fps, config: { damping: 13, stiffness: 70, mass: 1.1 } });
  const landFrame = Math.round(0.9 * fps);
  const x = interpolate(fly, [0, 1], [1500, 0]);
  const y = interpolate(fly, [0, 1], [700, 0]) - Math.sin(Math.min(1, fly) * Math.PI) * 260;
  const tilt = interpolate(fly, [0, 1], [-28, 0]);
  const bob = useBob(6, 40);
  const arm = useWaveAngle(landFrame, Math.round(3.6 * fps));
  const talking = frame > landFrame + 6 && frame < landFrame + 1.6 * fps;

  return (
    <NightBackdrop>
      <AbsoluteFill style={{ fontFamily: font.sans }}>
        <div
          style={{
            position: 'absolute',
            left: 230,
            top: 250,
            transform: `translate(${x}px, ${y + (fly > 0.98 ? bob : 0)}px) rotate(${tilt}deg)`,
          }}
        >
          <Clipa height={560} armAngle={arm} mouth={talking ? 'talk' : 'grin'} shadow lookX={0.5} />
        </div>

        <div style={{ position: 'absolute', left: 900, top: 270, display: 'flex', flexDirection: 'column', gap: 28 }}>
          <Bubble fromFrame={landFrame + 4} fontSize={78} weight={800} maxWidth={900}>
            {greeting}
          </Bubble>
          {line ? (
            <Bubble fromFrame={landFrame + Math.round(1.1 * fps)} fontSize={44} weight={500} maxWidth={900} tail="none">
              {line}
            </Bubble>
          ) : null}
        </div>
      </AbsoluteFill>
      {footer ? (
        <div
          style={{
            position: 'absolute',
            left: 140,
            bottom: 60,
            color: '#b7c9c5',
            fontFamily: font.sans,
            fontSize: 30,
            fontWeight: 500,
          }}
        >
          {footer}
        </div>
      ) : null}
      <div style={{ position: 'absolute', left: 0, bottom: 0, width: '100%', height: 6, background: color.teal, opacity: 0.6 }} />
    </NightBackdrop>
  );
};
