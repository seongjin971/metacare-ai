import { MAX_CAPTURE_PIXELS } from './picture-size.ts';

/** Same decode ceiling as the installed app's stamp. */
const MAX_SIDE = 4096;
const MARGIN = 0.03;
const FONT = 0.045;
const PADDING = 0.6;
const RADIUS = 0.7;
/** A canvas font has no ascent/descent to size the box, so the label line is 1.2 em tall. */
const LINE_HEIGHT = 1.2;

export type PhotoSize = { width: number; height: number };

export type StampLayout = {
  fontSize: number;
  radius: number;
  box: { x: number; y: number; width: number; height: number };
  /** Left edge and vertical centre of the label text. */
  text: { x: number; y: number };
};

/** The largest size with the same aspect ratio within the capture budget. Never upscales. */
export function fitPhotoSize(width: number, height: number, maxPixels = MAX_CAPTURE_PIXELS, maxSide = MAX_SIDE): PhotoSize {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('촬영한 사진의 크기를 확인할 수 없어요.');
  }
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)), maxSide / Math.max(width, height));
  if (scale >= 1) return { width, height };
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

/**
 * Where the capture-time label goes, matching the installed app's native stamp: a dark rounded
 * label in the bottom-left corner, sized to the photo and never wider than it.
 * `measure` returns the label's width at a font size.
 */
export function stampLayout(width: number, height: number, measure: (fontSize: number) => number): StampLayout {
  if (!(width > 0) || !(height > 0)) throw new Error('촬영한 사진의 크기를 확인할 수 없어요.');
  const shorter = Math.min(width, height);
  const margin = shorter * MARGIN;
  const available = width - margin * 2;
  let fontSize = shorter * FONT;
  const needed = measure(fontSize) + fontSize * PADDING * 2;
  if (needed > available) fontSize *= available / needed;
  const padding = fontSize * PADDING;
  const boxHeight = fontSize * LINE_HEIGHT + padding * 2;
  const top = height - margin - boxHeight;
  return {
    fontSize,
    radius: padding * RADIUS,
    box: { x: margin, y: top, width: measure(fontSize) + padding * 2, height: boxHeight },
    text: { x: margin + padding, y: top + boxHeight / 2 },
  };
}
