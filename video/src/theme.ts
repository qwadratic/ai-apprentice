// Clipa palette (taken from the paperclip drawing in apps/web/features/agent/clipa) and type.
export const WIDTH = 1920;
export const HEIGHT = 1080;
export const FPS = 30;

export const color = {
  ink: '#0f2d2a',
  inkSoft: '#14211f',
  deep: '#0b5d56',
  teal: '#17b3a3',
  tealDark: '#0f9585',
  tealLight: '#a3f2e7',
  plate: '#f1fbf9',
  cheek: '#ff8a73',
  amber: '#f5a524',
  amberDark: '#8f5200',
  paper: '#f6f8f8',
  surface: '#ffffff',
  border: '#d3dddb',
  muted: '#566764',
  night: '#0a1f1d',
  night2: '#0f2d2a',
} as const;

export const font = {
  sans: "Inter, 'Helvetica Neue', Arial, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, Menlo, 'DejaVu Sans Mono', monospace",
} as const;

export const secondsToFrames = (seconds: number, fps: number = FPS): number =>
  Math.max(1, Math.round(seconds * fps));
