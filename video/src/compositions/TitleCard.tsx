import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { NightBackdrop } from '../components/Backdrop';
import { Clipa, useBob } from '../components/Clipa';
import type { TitleCardScript } from '../script';
import { color, font } from '../theme';

const useEnter = (delayFrames: number): number => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - delayFrames, fps, config: { damping: 18, stiffness: 110 } });
};

export const TitleCard: React.FC<TitleCardScript> = ({ kicker, title, subtitle, footer, showClipa = true }) => {
  const kickerIn = useEnter(4);
  const titleIn = useEnter(10);
  const subtitleIn = useEnter(22);
  const footerIn = useEnter(34);
  const clipaIn = useEnter(14);
  const bob = useBob(7, 42);

  return (
    <NightBackdrop>
      <AbsoluteFill style={{ padding: '0 140px', justifyContent: 'center', fontFamily: font.sans }}>
        {kicker ? (
          <div
            style={{
              alignSelf: 'flex-start',
              marginBottom: 36,
              padding: '10px 26px',
              borderRadius: 999,
              border: `2px solid ${color.teal}`,
              color: color.tealLight,
              fontSize: 30,
              fontWeight: 600,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              opacity: kickerIn,
              transform: `translateY(${(1 - kickerIn) * 20}px)`,
            }}
          >
            {kicker}
          </div>
        ) : null}
        <div
          style={{
            maxWidth: 1280,
            color: '#ffffff',
            fontSize: 128,
            fontWeight: 800,
            lineHeight: 1.04,
            letterSpacing: '-0.035em',
            opacity: titleIn,
            transform: `translateY(${(1 - titleIn) * 50}px)`,
          }}
        >
          {title}
        </div>
        {subtitle ? (
          <div
            style={{
              marginTop: 36,
              maxWidth: 1180,
              color: color.tealLight,
              fontSize: 50,
              fontWeight: 500,
              lineHeight: 1.25,
              opacity: subtitleIn,
              transform: `translateY(${(1 - subtitleIn) * 30}px)`,
            }}
          >
            {subtitle}
          </div>
        ) : null}
      </AbsoluteFill>
      {footer ? (
        <div
          style={{
            position: 'absolute',
            left: 140,
            bottom: 70,
            color: '#b7c9c5',
            fontFamily: font.sans,
            fontSize: 30,
            fontWeight: 500,
            opacity: interpolate(footerIn, [0, 1], [0, 0.95]),
          }}
        >
          {footer}
        </div>
      ) : null}
      {showClipa ? (
        <div
          style={{
            position: 'absolute',
            right: 170,
            bottom: 80 - bob,
            opacity: clipaIn,
            transform: `translateY(${(1 - clipaIn) * 120}px) rotate(${(1 - clipaIn) * 12}deg)`,
          }}
        >
          <Clipa height={340} shadow lookX={-0.6} />
        </div>
      ) : null}
    </NightBackdrop>
  );
};
