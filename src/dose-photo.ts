import { POUCH_SLOTS, type PouchSlot } from '../shared/pouch-reading.ts';

export type PhotoVerification = { method: 'medicine-pouch-text-v1'; checkedAt: string };

export const PHOTO_READING_OUTCOMES = ['match', 'mismatch', 'read', 'unreadable', 'not_pouch'] as const;
export type PhotoReadingOutcome = typeof PHOTO_READING_OUTCOMES[number];
/** What the AI read on the pouch, compared with the dose it was taken for. A hint, never a proof of intake. */
export type PhotoReading = { method: 'claude-pouch-read-v1'; checkedAt: string; outcome: PhotoReadingOutcome; slots: PouchSlot[] };

/** A local photo reference. OCR text is never stored with the record. */
export type DosePhoto = {
  id: string;
  capturedAt: string;
  width: number;
  height: number;
  verification?: PhotoVerification;
  reading?: PhotoReading;
};

const isTimestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;

export function normalizePhotoVerification(value: unknown, capturedAt: string): PhotoVerification {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('약봉투 사진 확인이 필요해요. 다시 촬영해 주세요.');
  const check = value as Record<string, unknown>;
  if (check.method !== 'medicine-pouch-text-v1' || !isTimestamp(check.checkedAt) || Date.parse(check.checkedAt) < Date.parse(capturedAt)) {
    throw new Error('사진 확인 정보를 읽지 못했어요. 다시 촬영해 주세요.');
  }
  return { method: check.method, checkedAt: check.checkedAt };
}

export function normalizePhotoReading(value: unknown, capturedAt: string): PhotoReading {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AI 읽기 정보를 확인할 수 없어요.');
  const reading = value as Record<string, unknown>;
  const slots = reading.slots;
  if (reading.method !== 'claude-pouch-read-v1' || !isTimestamp(reading.checkedAt) || Date.parse(reading.checkedAt) < Date.parse(capturedAt)
    || !PHOTO_READING_OUTCOMES.includes(reading.outcome as PhotoReadingOutcome) || !Array.isArray(slots) || slots.length > POUCH_SLOTS.length
    || !slots.every(slot => POUCH_SLOTS.includes(slot as PouchSlot)) || new Set(slots).size !== slots.length) {
    throw new Error('AI 읽기 정보를 확인할 수 없어요.');
  }
  return { method: reading.method, checkedAt: reading.checkedAt, outcome: reading.outcome as PhotoReadingOutcome, slots: [...slots] as PouchSlot[] };
}

export function normalizeDosePhoto(value: unknown): DosePhoto {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('사진을 촬영한 뒤 복약을 기록해 주세요.');
  const photo = value as Record<string, unknown>;
  if (typeof photo.id !== 'string' || !/^photo-[A-Za-z0-9-]{1,120}$/.test(photo.id)) {
    throw new Error('촬영한 사진을 확인할 수 없어요. 다시 촬영해 주세요.');
  }
  if (!isTimestamp(photo.capturedAt)) {
    throw new Error('사진 촬영 시간을 확인할 수 없어요. 다시 촬영해 주세요.');
  }
  if (typeof photo.width !== 'number' || typeof photo.height !== 'number'
    || !Number.isInteger(photo.width) || !Number.isInteger(photo.height)
    || photo.width <= 0 || photo.height <= 0 || photo.width > 20000 || photo.height > 20000) {
    throw new Error('촬영한 사진이 올바르지 않아요. 다시 촬영해 주세요.');
  }
  return {
    id: photo.id, capturedAt: photo.capturedAt, width: photo.width, height: photo.height,
    ...(photo.verification === undefined ? {} : { verification: normalizePhotoVerification(photo.verification, photo.capturedAt) }),
    ...(photo.reading === undefined ? {} : { reading: normalizePhotoReading(photo.reading, photo.capturedAt) }),
  };
}

/** A new photo reference for a capture. The pouch-text check and the AI reading are optional. */
export function newDosePhoto(
  capture: { capturedAt: string; width: number; height: number; verification?: unknown; reading?: unknown },
  id = `photo-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`,
): DosePhoto {
  return normalizeDosePhoto({
    id,
    capturedAt: capture.capturedAt,
    width: capture.width,
    height: capture.height,
    ...(capture.verification ? { verification: normalizePhotoVerification(capture.verification, capture.capturedAt) } : {}),
    ...(capture.reading ? { reading: normalizePhotoReading(capture.reading, capture.capturedAt) } : {}),
  });
}

export function isDosePhoto(value: unknown): value is DosePhoto {
  try { normalizeDosePhoto(value); return true; } catch { return false; }
}
