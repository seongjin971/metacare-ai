import { MAX_PHOTO_BYTES } from '../shared/care-photo-parts';
import { photoStampLabel } from './photo-stamp-label';
import { fitPhotoSize, stampLayout } from './photo-stamp-layout';

export type DoseCapture = { uri: string; capturedAt: string; width: number; height: number };

const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif';
/** The installed app's JPEG quality first; lower only if the photo would exceed the sharing limit. */
const JPEG_QUALITIES = [0.88, 0.8, 0.7];

/** A browser can record a dose photo on a secure page that has camera access and photo storage. */
export function canCaptureDosePhoto(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined' || typeof document === 'undefined') return false;
  return window.isSecureContext !== false
    && typeof navigator.mediaDevices?.getUserMedia === 'function'
    && typeof indexedDB !== 'undefined';
}

function loadImage(uri: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      image.onload = null;
      image.onerror = null;
      resolve(image);
    };
    image.onerror = () => {
      image.onload = null;
      image.onerror = null;
      reject(new Error('촬영한 사진을 읽지 못했어요. 다시 촬영해 주세요.'));
    };
    image.src = uri;
  });
}

function base64Bytes(dataUri: string): number {
  const base64 = dataUri.slice(dataUri.indexOf(',') + 1);
  return base64.length * 3 / 4 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

/** Burns the capture time into a browser camera frame, laid out like the installed app's stamp. */
export async function stampDosePhoto(capture: DoseCapture): Promise<DoseCapture> {
  const label = photoStampLabel(new Date(capture.capturedAt));
  if (typeof capture.uri !== 'string' || !/^data:image\/(?:jpeg|png);base64,/.test(capture.uri)) {
    throw new Error('촬영한 사진이 올바르지 않아요. 다시 촬영해 주세요.');
  }
  const image = await loadImage(capture.uri);
  // A browser may report the camera track's size rather than the frame's (e.g. a rotated phone), so size from the pixels.
  const size = fitPhotoSize(image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('사진을 처리하지 못했어요. 다시 촬영해 주세요.');
  context.drawImage(image, 0, 0, size.width, size.height);
  const font = (fontSize: number) => `bold ${fontSize}px ${FONT_FAMILY}`;
  const layout = stampLayout(size.width, size.height, fontSize => {
    context.font = font(fontSize);
    return context.measureText(label).width;
  });
  context.fillStyle = 'rgba(0, 0, 0, 0.63)';
  roundedRect(context, layout.box.x, layout.box.y, layout.box.width, layout.box.height, layout.radius);
  context.fill();
  context.font = font(layout.fontSize);
  context.fillStyle = '#ffffff';
  context.textAlign = 'left';
  context.textBaseline = 'middle';
  context.fillText(label, layout.text.x, layout.text.y);
  for (const quality of JPEG_QUALITIES) {
    const uri = canvas.toDataURL('image/jpeg', quality);
    if (!uri.startsWith('data:image/jpeg;base64,')) break;
    if (base64Bytes(uri) <= MAX_PHOTO_BYTES) return { ...capture, uri, width: size.width, height: size.height };
  }
  throw new Error('사진 용량이 5MB를 넘어요. 약봉투 가까이에서 다시 촬영해 주세요.');
}
