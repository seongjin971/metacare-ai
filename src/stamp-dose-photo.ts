import { isPhotoStampAvailable, stampPhoto } from '../modules/medication-photo-analyzer';
import { photoStampLabel } from './photo-stamp-label';
import type { PhotoReading } from './dose-photo';

export type DoseCapture = { uri: string; capturedAt: string; width: number; height: number; reading?: PhotoReading };

/**
 * Dose photos are recorded as taken, with the capture time burned in, and the caregiver reviews
 * them. The automatic pouch-text check (verify-dose-photo.ts) is paused, not removed.
 */
export const canCaptureDosePhoto = isPhotoStampAvailable;

export async function stampDosePhoto(capture: DoseCapture): Promise<DoseCapture> {
  const stamped = await stampPhoto(capture.uri, photoStampLabel(new Date(capture.capturedAt)));
  return { ...capture, uri: stamped.uri, width: stamped.width, height: stamped.height };
}
