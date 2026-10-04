// A screen source that needs no tab capture: it paints the simulated desktop (its DOM) into a canvas a few times a second
// and returns canvas.captureStream(). Use it as the `fallback` of installSimMedia's screen option, for browsers that cannot
// capture a tab (headless Chrome fails with NotReadableError or hangs; the real getDisplayMedia is still preferred
// wherever it works). Everything after this point is the real pipeline: the stream is read like a screen share.
//
// How it paints: the element is cloned with the computed style of every node written into the clone, form values and
// scroll offsets copied over, wrapped in an SVG foreignObject, and drawn from a data: URL onto the canvas. That is a faithful
// picture of layout, text, colours and images; it is not pixel-identical to a real capture (no pseudo-elements, no native
// form-control rendering, no caret). The page says so in the report: the capture source is "canvas", not "tab".
export interface CanvasScreenOptions {
  /** Frames per second painted and offered to the stream (default 2: vision samples at about 1 frame per 1 to 2 s). */
  fps?: number;
  /** Canvas pixels per CSS pixel (default 1). */
  scale?: number;
}

export interface CanvasScreen {
  readonly stream: MediaStream;
  readonly canvas: HTMLCanvasElement;
  framesPainted(): number;
  lastError(): string | null;
  stop(): void;
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'LINK', 'META']);

/** Copies what the stylesheet decided (the computed style) and the live state (values, scroll) from `source` onto `copy`. */
function copyNode(source: Element, copy: Element): void {
  const computed = getComputedStyle(source);
  const style = (copy as HTMLElement).style;
  for (let i = 0; i < computed.length; i += 1) {
    const name = computed.item(i);
    style.setProperty(name, computed.getPropertyValue(name), computed.getPropertyPriority(name));
  }
  if (source instanceof HTMLInputElement) {
    copy.setAttribute('value', source.value);
    if (source.checked) copy.setAttribute('checked', '');
    else copy.removeAttribute('checked');
  } else if (source instanceof HTMLTextAreaElement) {
    copy.textContent = source.value;
  } else if (source instanceof HTMLSelectElement && copy instanceof HTMLSelectElement) {
    for (let i = 0; i < copy.options.length; i += 1) {
      const option = copy.options[i];
      if (option) option.selected = i === source.selectedIndex;
    }
  }
}

function cloneForPaint(source: Element): Element {
  const copy = source.cloneNode(false) as Element;
  copyNode(source, copy);
  // Text-like controls hold their text in the copy already; do not clone their children over it.
  if (source instanceof HTMLTextAreaElement) return copy;
  const scrollTop = source instanceof HTMLElement ? source.scrollTop : 0;
  const scrollLeft = source instanceof HTMLElement ? source.scrollLeft : 0;
  let parent: Element = copy;
  if (scrollTop !== 0 || scrollLeft !== 0) {
    // A scrolled container: move its content by the scroll offset inside the clipped copy.
    const shift = copy.ownerDocument.createElement('div');
    shift.setAttribute('style', `position:relative;top:${-scrollTop}px;left:${-scrollLeft}px;`);
    copy.append(shift);
    parent = shift;
  }
  for (const child of Array.from(source.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      parent.append(child.cloneNode(true));
    } else if (child instanceof Element && !SKIP_TAGS.has(child.tagName)) {
      parent.append(cloneForPaint(child));
    }
  }
  return copy;
}

function toSvgUrl(root: Element, width: number, height: number): string {
  const xhtml = new XMLSerializer().serializeToString(cloneForPaint(root));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject x="0" y="0" width="100%" height="100%">${xhtml}</foreignObject></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function createCanvasScreen(root: HTMLElement, options: CanvasScreenOptions = {}): CanvasScreen {
  const fps = options.fps ?? 2;
  const scale = options.scale ?? 1;
  const canvas = root.ownerDocument.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('a 2d canvas is not available');
  const state = { frames: 0, error: null as string | null, painting: false, stopped: false };

  const paint = (): void => {
    if (state.painting || state.stopped) return;
    const box = root.getBoundingClientRect();
    const width = Math.max(1, Math.round(box.width));
    const height = Math.max(1, Math.round(box.height));
    state.painting = true;
    const image = new Image();
    image.onload = () => {
      if (!state.stopped) {
        if (canvas.width !== width * scale || canvas.height !== height * scale) {
          canvas.width = width * scale;
          canvas.height = height * scale;
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        state.frames += 1;
      }
      state.painting = false;
    };
    image.onerror = () => {
      state.error = 'the desktop could not be painted into the canvas';
      state.painting = false;
    };
    try {
      image.src = toSvgUrl(root, width, height);
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      state.painting = false;
    }
  };

  const box = root.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(box.width)) * scale;
  canvas.height = Math.max(1, Math.round(box.height)) * scale;
  paint();
  const timer = window.setInterval(paint, Math.round(1000 / fps));
  const stream = canvas.captureStream(fps);
  return {
    stream,
    canvas,
    framesPainted: () => state.frames,
    lastError: () => state.error,
    stop: () => {
      state.stopped = true;
      window.clearInterval(timer);
      for (const track of stream.getTracks()) track.stop();
    },
  };
}
