// The script format. Every word on screen comes from a JSON file in video/scripts/ that has
// one of these shapes; the compositions hold no copy of their own. Times are in seconds and
// count from the start of the scene they belong to.

export type TitleCardScript = {
  durationSec: number;
  /** Small label above the title. */
  kicker?: string;
  title: string;
  subtitle?: string;
  footer?: string;
  /** Draw the small Clipa in the corner. Default true. */
  showClipa?: boolean;
};

export type CaptionScript = { fromSec: number; toSec: number; text: string };

/** A box over the clip. x, y, w, h are fractions (0 to 1) of the clip picture. */
export type HighlightScript = {
  fromSec: number;
  toSec: number;
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string;
};

export type CaptionedClipScript = {
  durationSec: number;
  /** File under video/assets, e.g. "recordings/sample.mp4", or an http(s) URL. */
  src: string;
  /** Trim: where in the source file the scene starts. Default 0. */
  startFromSec?: number;
  playbackRate?: number;
  /** "framed" (default) shows the clip in a rounded frame with a caption band; "full" fills the screen. */
  layout?: 'framed' | 'full';
  /** Small label at the top left, e.g. the mode name. */
  heading?: string;
  /** Honesty label shown on the clip, e.g. "Recorded run, synthetic demo data". */
  badge?: string;
  captions: CaptionScript[];
  highlights?: HighlightScript[];
  /** Zoom into a point of the picture: x, y are fractions (0 to 1), scale is the magnification. Eases in and out over 0.6 s. */
  zoom?: { fromSec: number; toSec: number; x: number; y: number; scale: number }[];
};

export type ClipaIntroScript = {
  durationSec: number;
  greeting: string;
  line?: string;
  footer?: string;
};

export type ClipaOutroScript = {
  durationSec: number;
  headline: string;
  lines?: string[];
  links?: { label: string; url: string }[];
  note?: string;
};

export type LayerScript = { name: string; caption: string; example: string };

export type LayersDiagramScript = {
  durationSec: number;
  title: string;
  subtitle?: string;
  layers: LayerScript[];
  /** Label above the examples, e.g. "customer_07 (synthetic)". */
  exampleLabel?: string;
  /** What Clipa asks at the pause, and the expert's answer. */
  question?: { ask: string; answer: string };
  footer?: string;
};

export type ArchNodeScript = {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub?: string;
  /** When the node appears, in seconds from the scene start. */
  atSec: number;
  tone?: 'plain' | 'teal' | 'amber';
};

export type ArchEdgeScript = {
  from: [number, number];
  to: [number, number];
  via?: [number, number][];
  label?: string;
  labelAt?: [number, number];
  atSec: number;
  /** Arrow heads at both ends. */
  both?: boolean;
  tone?: 'teal' | 'amber';
};

/** A box-and-arrow diagram; coordinates are pixels on the 1920x1080 frame. */
export type ArchitectureScript = {
  durationSec: number;
  title: string;
  kicker?: string;
  footer?: string;
  groups?: { x: number; y: number; w: number; h: number; label: string; atSec: number }[];
  nodes: ArchNodeScript[];
  edges?: ArchEdgeScript[];
  captions?: CaptionScript[];
};

/** A title, facts that appear one by one, an optional code panel and timed captions. */
export type FactsScript = {
  durationSec: number;
  title: string;
  kicker?: string;
  items: { text: string; atSec: number }[];
  code?: { title: string; text: string; atSec: number };
  footer?: string;
  captions?: CaptionScript[];
  showClipa?: boolean;
};

export type SceneScript =
  | ({ type: 'title' } & TitleCardScript)
  | ({ type: 'architecture' } & ArchitectureScript)
  | ({ type: 'facts' } & FactsScript)
  | ({ type: 'clip' } & CaptionedClipScript)
  | ({ type: 'clipa-intro' } & ClipaIntroScript)
  | ({ type: 'clipa-outro' } & ClipaOutroScript)
  | ({ type: 'layers' } & LayersDiagramScript);

export type StoryboardScript = {
  /** Cross-fade between scenes, in seconds. Default 0.5. */
  transitionSec?: number;
  scenes: SceneScript[];
};

export const storyboardDurationSec = (script: StoryboardScript): number => {
  const transition = script.transitionSec ?? 0.5;
  const total = script.scenes.reduce((sum, scene) => sum + scene.durationSec, 0);
  return total - transition * Math.max(0, script.scenes.length - 1);
};
