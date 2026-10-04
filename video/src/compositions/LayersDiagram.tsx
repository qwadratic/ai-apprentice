import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Clipa } from '../components/Clipa';
import type { LayersDiagramScript } from '../script';
import { color, font } from '../theme';

const CARD_W = 370;
const CARD_H = 372;
const GAP = 100;
const CARD_TOP = 236;
const EXAMPLE_TOP = 654;

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

const useSpring = (startFrame: number, damping = 16): number => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - startFrame, fps, config: { damping, stiffness: 120 } });
};

const Card: React.FC<{
  index: number;
  name: string;
  caption: string;
  startFrame: number;
  endFrame: number;
}> = ({ index, name, caption, startFrame, endFrame }) => {
  const frame = useCurrentFrame();
  const enter = useSpring(startFrame);
  const active = frame >= startFrame && frame < endFrame;
  const left = 70 + index * (CARD_W + GAP);
  return (
    <div
      style={{
        position: 'absolute',
        left,
        top: CARD_TOP,
        width: CARD_W,
        height: CARD_H,
        boxSizing: 'border-box',
        padding: '28px 28px',
        borderRadius: 28,
        background: color.surface,
        border: `${active ? 5 : 2}px solid ${active ? color.teal : color.border}`,
        boxShadow: active ? `0 18px 44px ${color.teal}44` : '0 8px 24px rgba(15,45,42,0.08)',
        opacity: enter,
        transform: `translateY(${(1 - enter) * 60}px) scale(${active ? 1.02 : 1})`,
      }}
    >
      <div
        style={{
          width: 64,
          height: 64,
          borderRadius: 32,
          background: color.teal,
          color: '#ffffff',
          fontSize: 34,
          fontWeight: 800,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {index + 1}
      </div>
      <div style={{ marginTop: 18, fontSize: 50, fontWeight: 800, letterSpacing: '-0.02em', color: color.ink }}>{name}</div>
      <div style={{ marginTop: 12, fontSize: 28, fontWeight: 500, lineHeight: 1.35, color: color.muted }}>{caption}</div>
    </div>
  );
};

const Arrow: React.FC<{ index: number; startFrame: number }> = ({ index, startFrame }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const x0 = 70 + index * (CARD_W + GAP) + CARD_W + 8;
  const x1 = x0 + GAP - 16;
  const y = CARD_TOP + CARD_H / 2;
  const grow = interpolate(frame, [startFrame, startFrame + 0.5 * fps], [0, 1], clamp);
  const dotPhase = ((frame - startFrame - 0.5 * fps) % 28) / 28;
  const showDot = frame > startFrame + 0.5 * fps;
  return (
    <>
      <div
        style={{
          position: 'absolute',
          left: x0,
          top: y - 3,
          width: (x1 - x0) * grow,
          height: 6,
          borderRadius: 3,
          background: color.teal,
        }}
      />
      {grow > 0.95 ? (
        <div
          style={{
            position: 'absolute',
            left: x1 - 10,
            top: y - 14,
            width: 0,
            height: 0,
            borderTop: '14px solid transparent',
            borderBottom: '14px solid transparent',
            borderLeft: `20px solid ${color.teal}`,
          }}
        />
      ) : null}
      {showDot ? (
        <div
          style={{
            position: 'absolute',
            left: x0 + (x1 - x0 - 20) * dotPhase,
            top: y - 9,
            width: 18,
            height: 18,
            borderRadius: 9,
            background: color.amber,
            border: `3px solid ${color.amberDark}`,
            boxSizing: 'border-box',
          }}
        />
      ) : null}
    </>
  );
};

const Example: React.FC<{ index: number; text: string; startFrame: number }> = ({ index, text, startFrame }) => {
  const enter = useSpring(startFrame, 20);
  const left = 70 + index * (CARD_W + GAP);
  return (
    <>
      <div
        style={{
          position: 'absolute',
          left: left + CARD_W / 2 - 2,
          top: CARD_TOP + CARD_H,
          width: 4,
          height: (EXAMPLE_TOP - CARD_TOP - CARD_H) * enter,
          background: color.border,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left,
          top: EXAMPLE_TOP,
          width: CARD_W,
          boxSizing: 'border-box',
          padding: '16px 20px',
          borderRadius: 18,
          background: '#e6f6f3',
          border: `2px dashed ${color.teal}`,
          color: color.deep,
          fontFamily: font.mono,
          fontSize: 23,
          fontWeight: 500,
          lineHeight: 1.4,
          opacity: enter,
          transform: `translateY(${(1 - enter) * 20}px)`,
        }}
      >
        {text}
      </div>
    </>
  );
};

export const LayersDiagram: React.FC<LayersDiagramScript> = ({
  title,
  subtitle,
  layers,
  exampleLabel,
  question,
  footer,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const n = Math.max(1, layers.length);
  const introFrames = Math.round(1.0 * fps);
  const outroFrames = question ? Math.round(5 * fps) : Math.round(1.5 * fps);
  const stepFrames = Math.max(Math.round(1.5 * fps), Math.floor((durationInFrames - introFrames - outroFrames) / n));
  const layerStart = (i: number): number => introFrames + i * stepFrames;
  const questionStart = introFrames + n * stepFrames;

  const titleIn = useSpring(2);
  const askIn = useSpring(questionStart);
  const answerIn = useSpring(questionStart + Math.round(1.8 * fps));
  const labelIn = interpolate(frame, [layerStart(0) + fps, layerStart(0) + 1.6 * fps], [0, 1], clamp);

  return (
    <AbsoluteFill style={{ background: color.paper, fontFamily: font.sans }}>
      <div style={{ position: 'absolute', left: 70, top: 56, opacity: titleIn, transform: `translateY(${(1 - titleIn) * 24}px)` }}>
        <div style={{ fontSize: 68, fontWeight: 800, letterSpacing: '-0.03em', color: color.ink }}>{title}</div>
        {subtitle ? <div style={{ marginTop: 6, fontSize: 32, fontWeight: 500, color: color.muted }}>{subtitle}</div> : null}
      </div>

      {exampleLabel ? (
        <div
          style={{
            position: 'absolute',
            right: 70,
            top: 74,
            padding: '10px 24px',
            borderRadius: 999,
            background: '#fcefcf',
            border: `2px solid ${color.amber}`,
            color: '#7a4a00',
            fontSize: 26,
            fontWeight: 600,
            opacity: labelIn,
          }}
        >
          {exampleLabel}
        </div>
      ) : null}

      {layers.map((layer, i) => (
        <Card
          key={layer.name}
          index={i}
          name={layer.name}
          caption={layer.caption}
          startFrame={layerStart(i)}
          endFrame={i === n - 1 ? questionStart : layerStart(i + 1)}
        />
      ))}
      {layers.slice(1).map((layer, i) => (
        <Arrow key={`arrow-${layer.name}`} index={i} startFrame={layerStart(i + 1) - Math.round(0.5 * fps)} />
      ))}
      {layers.map((layer, i) => (
        <Example key={`ex-${layer.name}`} index={i} text={layer.example} startFrame={layerStart(i) + Math.round(1.1 * fps)} />
      ))}

      {question ? (
        <>
          <div
            style={{
              position: 'absolute',
              left: 70,
              top: 826,
              opacity: askIn,
              transform: `translateY(${(1 - askIn) * 40}px)`,
            }}
          >
            <Clipa height={190} mouth="talk" lookX={0.4} />
          </div>
          <div
            style={{
              position: 'absolute',
              left: 300,
              top: 846,
              width: 760,
              boxSizing: 'border-box',
              padding: '22px 30px',
              borderRadius: 26,
              background: color.surface,
              border: `4px solid ${color.teal}`,
              color: color.ink,
              fontSize: 31,
              fontWeight: 600,
              lineHeight: 1.3,
              opacity: askIn,
              transform: `scale(${0.9 + 0.1 * askIn})`,
              transformOrigin: 'left center',
            }}
          >
            <div style={{ fontSize: 22, fontWeight: 700, color: color.deep, marginBottom: 6, letterSpacing: '0.04em' }}>
              CLIPA ASKS AT THE PAUSE
            </div>
            {question.ask}
          </div>
          <div
            style={{
              position: 'absolute',
              left: 1120,
              top: 846,
              width: 730,
              boxSizing: 'border-box',
              padding: '22px 30px',
              borderRadius: 26,
              background: '#fcefcf',
              border: `4px solid ${color.amber}`,
              color: '#3a2400',
              fontSize: 31,
              fontWeight: 600,
              lineHeight: 1.3,
              opacity: answerIn,
              transform: `scale(${0.9 + 0.1 * answerIn})`,
              transformOrigin: 'right center',
            }}
          >
            <div style={{ fontSize: 22, fontWeight: 700, color: '#7a4a00', marginBottom: 6, letterSpacing: '0.04em' }}>
              THE EXPERT ANSWERS
            </div>
            {question.answer}
          </div>
        </>
      ) : null}

      {footer ? (
        <div style={{ position: 'absolute', left: 70, bottom: 26, fontSize: 24, fontWeight: 500, color: color.muted }}>{footer}</div>
      ) : null}
    </AbsoluteFill>
  );
};
