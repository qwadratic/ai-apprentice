/** Rectangles use normalized source coordinates, never CSS preview coordinates. */
export interface PrivacyMask {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Geometry {
  readonly width: number;
  readonly height: number;
  readonly revision: number;
}

export function validateMasks(masks: readonly PrivacyMask[]): readonly PrivacyMask[] {
  const ids = new Set<string>();
  return Object.freeze(masks.map((mask) => {
    const { id, x, y, width, height } = mask;
    if (!id || ids.has(id) || ![x, y, width, height].every(Number.isFinite) ||
        x < 0 || y < 0 || width <= 0 || height <= 0 ||
        x + width > 1 + Number.EPSILON || y + height > 1 + Number.EPSILON) {
      throw new RangeError('Masks must be unique, nonempty rectangles inside the source.');
    }
    ids.add(id);
    return Object.freeze({ id, x, y, width, height });
  }));
}

export function maskPixels(mask: PrivacyMask, width: number, height: number) {
  // Round outwards so fractional edges cannot reveal partially covered pixels.
  const x = Math.floor(mask.x * width);
  const y = Math.floor(mask.y * height);
  return {
    x, y,
    width: Math.min(width, Math.ceil((mask.x + mask.width) * width)) - x,
    height: Math.min(height, Math.ceil((mask.y + mask.height) * height)) - y,
  };
}

export function paintMasks(
  context: CanvasRenderingContext2D,
  masks: readonly PrivacyMask[],
  width: number,
  height: number,
): void {
  context.save();
  try {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
    context.fillStyle = '#000000';
    for (const mask of masks) {
      const rect = maskPixels(mask, width, height);
      context.fillRect(rect.x, rect.y, rect.width, rect.height);
    }
  } finally {
    context.restore();
  }
}
