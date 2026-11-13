import type { PouchReading, PouchSlot } from '../shared/pouch-reading.ts';
import type { PhotoReading } from './dose-photo.ts';
import { doseSlot } from './medicine-pouch-check.ts';

const SLOT_FOR_DOSE: Record<'아침' | '점심' | '저녁', PouchSlot> = { 아침: 'morning', 점심: 'noon', 저녁: 'evening' };
const SLOT_NAMES: Record<PouchSlot, string> = { morning: '아침', noon: '점심', evening: '저녁', bedtime: '취침 전' };

/** Compares what the AI read with the dose being recorded. A low-confidence reading counts as unreadable. */
export function photoReadingFor(reading: PouchReading | null, doseLabel: string, checkedAt = new Date()): PhotoReading {
  const base = { method: 'claude-pouch-read-v1' as const, checkedAt: checkedAt.toISOString() };
  if (!reading) return { ...base, outcome: 'unreadable', slots: [] };
  if (!reading.isPouch) return { ...base, outcome: 'not_pouch', slots: [] };
  if (!reading.slots.length || reading.confidence === 'low') return { ...base, outcome: 'unreadable', slots: [] };
  const slot = doseSlot(doseLabel);
  // A once-daily dose has no slot in its label, so the reading is shown without a verdict.
  if (!slot) return { ...base, outcome: 'read', slots: reading.slots };
  return { ...base, outcome: reading.slots.includes(SLOT_FOR_DOSE[slot]) ? 'match' : 'mismatch', slots: reading.slots };
}

const slotList = (slots: PouchSlot[]) => slots.map(slot => `'${SLOT_NAMES[slot]}'`).join('·');

/** The sentence shown under the photo preview. */
export function photoReadingMessage(reading: PhotoReading, doseLabel: string): string {
  switch (reading.outcome) {
    case 'match':
    case 'read': return `AI가 ${slotList(reading.slots)} 봉투로 읽었어요.`;
    case 'mismatch': return `AI가 ${slotList(reading.slots)} 봉투로 읽었어요. ${doseLabel}이 맞는지 봉투를 확인해 주세요.`;
    case 'not_pouch': return 'AI가 사진에서 약봉투를 찾지 못했어요. 다시 찍거나 그대로 기록해도 돼요.';
    default: return 'AI가 봉투 글씨를 읽지 못했어요. 그대로 기록해도 돼요.';
  }
}

/** A short note next to a recorded dose. */
export function photoReadingLabel(reading: PhotoReading): string {
  switch (reading.outcome) {
    case 'match':
    case 'read': return `AI ${reading.slots.map(slot => SLOT_NAMES[slot]).join('·')} 봉투`;
    case 'mismatch': return 'AI 확인 필요';
    default: return 'AI 읽기 안 됨';
  }
}
