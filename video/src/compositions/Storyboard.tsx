import React from 'react';
import { TransitionSeries, linearTiming } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import { useVideoConfig } from 'remotion';
import type { SceneScript, StoryboardScript } from '../script';
import { secondsToFrames } from '../theme';
import { CaptionedClip } from './CaptionedClip';
import { ClipaIntro } from './ClipaIntro';
import { ClipaOutro } from './ClipaOutro';
import { LayersDiagram } from './LayersDiagram';
import { TitleCard } from './TitleCard';

const Scene: React.FC<{ scene: SceneScript }> = ({ scene }) => {
  switch (scene.type) {
    case 'title':
      return <TitleCard {...scene} />;
    case 'clip':
      return <CaptionedClip {...scene} />;
    case 'clipa-intro':
      return <ClipaIntro {...scene} />;
    case 'clipa-outro':
      return <ClipaOutro {...scene} />;
    case 'layers':
      return <LayersDiagram {...scene} />;
  }
};

/**
 * Chains the scenes of a script with cross-fades. A scene's durationSec counts in full; each
 * cross-fade overlaps two neighbours, so the video is shorter by transitionSec per join.
 */
export const Storyboard: React.FC<StoryboardScript> = ({ scenes, transitionSec = 0.5 }) => {
  const { fps } = useVideoConfig();
  const transitionFrames = secondsToFrames(transitionSec, fps);
  const items: React.ReactNode[] = [];
  scenes.forEach((scene, i) => {
    items.push(
      <TransitionSeries.Sequence key={`scene-${i}`} durationInFrames={secondsToFrames(scene.durationSec, fps)}>
        <Scene scene={scene} />
      </TransitionSeries.Sequence>,
    );
    if (i < scenes.length - 1) {
      items.push(
        <TransitionSeries.Transition
          key={`fade-${i}`}
          presentation={fade()}
          timing={linearTiming({ durationInFrames: transitionFrames })}
        />,
      );
    }
  });
  return <TransitionSeries>{items}</TransitionSeries>;
};
