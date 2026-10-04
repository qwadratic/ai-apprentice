import React from 'react';
import { spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { NightBackdrop } from '../components/Backdrop';
import { Clipa } from '../components/Clipa';
import type { FactsScript } from '../script';
import { color, font } from '../theme';
import { SceneCaption } from './Architecture';

const useEnter = (atSec: number): number => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - atSec * fps, fps, config: { damping: 18, stiffness: 120 } });
};

const Item: React.FC<{ text: string; atSec: number }> = ({ text, atSec }) => {
  const enter = useEnter(atSec);
  return (
    <div
      style={{
        display: 'flex',
        gap: 22,
        alignItems: 'flex-start',
        opacity: enter,
        transform: `translateX(${(1 - enter) * -40}px)`,
        color: '#ffffff',
        fontFamily: font.sans,
        fontSize: 40,
        fontWeight: 600,
        lineHeight: 1.3,
      }}
    >
      <div style={{ flex: '0 0 auto', width: 18, height: 18, marginTop: 18, borderRadius: 9, background: color.teal }} />
      <div>{text}</div>
    </div>
  );
};

const Code: React.FC<NonNullable<FactsScript['code']>> = ({ title, text, atSec }) => {
  const enter = useEnter(atSec);
  return (
    <div
      style={{
        position: 'absolute',
        right: 60,
        top: 200,
        width: 860,
        borderRadius: 22,
        overflow: 'hidden',
        background: '#06120f',
        boxShadow: '0 24px 60px rgba(0,0,0,0.5), 0 0 0 2px #ffffff1a',
        opacity: enter,
        transform: `translateY(${(1 - enter) * 40}px)`,
      }}
    >
      <div style={{ padding: '14px 24px', background: '#0f2d2a', color: color.tealLight, fontFamily: font.mono, fontSize: 22, fontWeight: 700 }}>
        {title}
      </div>
      <pre style={{ margin: 0, padding: '20px 26px', color: '#d9f7f2', fontFamily: font.mono, fontSize: 23, lineHeight: 1.42, whiteSpace: 'pre-wrap' }}>
        {text}
      </pre>
    </div>
  );
};

/** A title, facts that appear one by one, an optional code panel on the right, and timed captions. */
export const Facts: React.FC<FactsScript> = ({ kicker, title, items, code, footer, captions, showClipa = false }) => (
  <NightBackdrop>
    <div style={{ position: 'absolute', left: 80, top: 60, right: code ? 980 : 80, fontFamily: font.sans }}>
      {kicker ? (
        <div style={{ color: color.tealLight, fontSize: 28, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 10 }}>
          {kicker}
        </div>
      ) : null}
      <div style={{ color: '#ffffff', fontSize: 64, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.08 }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 26, marginTop: 50 }}>
        {items.map((item, i) => (
          <Item key={i} {...item} />
        ))}
      </div>
    </div>
    {code ? <Code {...code} /> : null}
    {showClipa ? (
      <div style={{ position: 'absolute', right: 70, bottom: 150 }}>
        <Clipa height={190} />
      </div>
    ) : null}
    {footer ? (
      <div style={{ position: 'absolute', left: 80, bottom: 140, color: '#ffffffb3', fontFamily: font.sans, fontSize: 28 }}>{footer}</div>
    ) : null}
    <SceneCaption captions={captions} />
  </NightBackdrop>
);
