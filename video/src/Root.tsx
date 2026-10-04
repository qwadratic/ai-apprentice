import React from 'react';
import { Composition } from 'remotion';
import './fonts';
import { CaptionedClip } from './compositions/CaptionedClip';
import { ClipaIntro } from './compositions/ClipaIntro';
import { ClipaOutro } from './compositions/ClipaOutro';
import { LayersDiagram } from './compositions/LayersDiagram';
import { Storyboard } from './compositions/Storyboard';
import { TitleCard } from './compositions/TitleCard';
import type {
  CaptionedClipScript,
  ClipaIntroScript,
  ClipaOutroScript,
  LayersDiagramScript,
  StoryboardScript,
  TitleCardScript,
} from './script';
import { storyboardDurationSec } from './script';
import { FPS, HEIGHT, WIDTH, secondsToFrames } from './theme';

// All copy lives in these files. Edit them, or pass another file with `npm run render -- <Id> --script <file>`.
import titleCardScript from '../scripts/title-card.json';
import captionedClipScript from '../scripts/captioned-clip.json';
import clipaIntroScript from '../scripts/clipa-intro.json';
import clipaOutroScript from '../scripts/clipa-outro.json';
import layersDiagramScript from '../scripts/layers-diagram.json';
import sampleScript from '../scripts/sample.json';

const base = { width: WIDTH, height: HEIGHT, fps: FPS, durationInFrames: FPS * 5 } as const;

const byDuration = <P extends { durationSec: number }>({ props }: { props: P }) => ({
  durationInFrames: secondsToFrames(props.durationSec),
});

export const Root: React.FC = () => (
  <>
    <Composition
      id="TitleCard"
      component={TitleCard}
      {...base}
      defaultProps={titleCardScript as TitleCardScript}
      calculateMetadata={byDuration}
    />
    <Composition
      id="CaptionedClip"
      component={CaptionedClip}
      {...base}
      defaultProps={captionedClipScript as CaptionedClipScript}
      calculateMetadata={byDuration}
    />
    <Composition
      id="ClipaIntro"
      component={ClipaIntro}
      {...base}
      defaultProps={clipaIntroScript as ClipaIntroScript}
      calculateMetadata={byDuration}
    />
    <Composition
      id="ClipaOutro"
      component={ClipaOutro}
      {...base}
      defaultProps={clipaOutroScript as ClipaOutroScript}
      calculateMetadata={byDuration}
    />
    <Composition
      id="LayersDiagram"
      component={LayersDiagram}
      {...base}
      defaultProps={layersDiagramScript as LayersDiagramScript}
      calculateMetadata={byDuration}
    />
    <Composition
      id="Sample"
      component={Storyboard}
      {...base}
      defaultProps={sampleScript as StoryboardScript}
      calculateMetadata={({ props }) => ({ durationInFrames: secondsToFrames(storyboardDurationSec(props)) })}
    />
  </>
);
