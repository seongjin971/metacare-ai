import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialState, recordDose, validateLoadedState } from '../src/domain.ts';
import { newDosePhoto, normalizeDosePhoto } from '../src/dose-photo.ts';
import { photoReadingFor, photoReadingLabel, photoReadingMessage } from '../src/pouch-reading-outcome.ts';
import type { PouchReading } from '../shared/pouch-reading.ts';

const READING: PouchReading = {
  isPouch: true, slots: ['evening'], mealTiming: 'after_meal', minutesFromMeal: 30,
  timesPerDay: 3, daysSupply: 7, photoQuality: 'clear', confidence: 'high',
};
const checkedAt = new Date('2026-11-13T10:00:05.000Z');

test('the AI reading is compared with the dose slot, and an unsure or empty reading is never a verdict', () => {
  assert.deepEqual(photoReadingFor(READING, '저녁 복용약', checkedAt),
    { method: 'claude-pouch-read-v1', checkedAt: checkedAt.toISOString(), outcome: 'match', slots: ['evening'] });
  assert.equal(photoReadingFor({ ...READING, slots: ['noon'] }, '저녁 복용약', checkedAt).outcome, 'mismatch');
  assert.equal(photoReadingFor({ ...READING, slots: ['noon', 'evening'] }, '저녁 복용약', checkedAt).outcome, 'match');
  assert.equal(photoReadingFor(READING, '복용약', checkedAt).outcome, 'read');
  assert.equal(photoReadingFor(READING, '아침 복용약', checkedAt).outcome, 'mismatch');
  const unsure: [PouchReading | null, string][] = [
    [null, 'unreadable'], [{ ...READING, isPouch: false }, 'not_pouch'],
    [{ ...READING, slots: [] }, 'unreadable'], [{ ...READING, confidence: 'low' }, 'unreadable'],
  ];
  for (const [reading, outcome] of unsure) {
    const result = photoReadingFor(reading, '저녁 복용약', checkedAt);
    assert.equal(result.outcome, outcome);
    assert.deepEqual(result.slots, []);
  }
});

test('preview and record texts say what the AI read without claiming the medicine was taken', () => {
  const match = photoReadingFor(READING, '저녁 복용약', checkedAt);
  const mismatch = photoReadingFor({ ...READING, slots: ['noon'] }, '저녁 복용약', checkedAt);
  assert.equal(photoReadingMessage(match, '저녁 복용약'), "AI가 '저녁' 봉투로 읽었어요.");
  assert.equal(photoReadingMessage(mismatch, '저녁 복용약'), "AI가 '점심' 봉투로 읽었어요. 저녁 복용약이 맞는지 봉투를 확인해 주세요.");
  assert.match(photoReadingMessage(photoReadingFor(null, '저녁 복용약', checkedAt), '저녁 복용약'), /그대로 기록해도 돼요/);
  assert.match(photoReadingMessage(photoReadingFor({ ...READING, isPouch: false }, '저녁 복용약', checkedAt), '저녁 복용약'), /약봉투를 찾지 못했어요/);
  assert.equal(photoReadingLabel(match), 'AI 저녁 봉투');
  assert.equal(photoReadingLabel(mismatch), 'AI 확인 필요');
  assert.equal(photoReadingLabel(photoReadingFor(null, '저녁 복용약', checkedAt)), 'AI 읽기 안 됨');
  for (const reading of [match, mismatch]) assert.doesNotMatch(photoReadingMessage(reading, '저녁 복용약'), /드셨|복용했|인증/);
});

test('a saved photo keeps a valid AI reading made after the capture and before the record', () => {
  const capturedAt = '2026-11-13T10:00:00.000Z';
  const reading = photoReadingFor(READING, '저녁 복용약', checkedAt);
  const photo = newDosePhoto({ capturedAt, width: 1920, height: 1080, reading }, 'photo-ai-1');
  assert.deepEqual(photo.reading, reading);
  assert.deepEqual(normalizeDosePhoto(photo), photo);
  for (const invalid of [
    { ...reading, method: 'guess' }, { ...reading, checkedAt: '2026-11-13T09:59:59.000Z' }, { ...reading, outcome: 'taken' },
    { ...reading, slots: ['evening', 'evening'] }, { ...reading, slots: ['dinner'] }, { ...reading, checkedAt: 'later' },
  ]) assert.throws(() => newDosePhoto({ capturedAt, width: 1920, height: 1080, reading: invalid }, 'photo-ai-2'), /AI 읽기/);

  const state = createInitialState(new Date(2026, 10, 13, 7));
  const dose = state.doses[state.doses.length - 1];
  const recordedAt = new Date(checkedAt.getTime() + 1000);
  const recorded = recordDose(state, dose.id, true, recordedAt, photo);
  assert.deepEqual(recorded.doses.find(item => item.id === dose.id)?.photo?.reading, reading);
  assert.throws(() => recordDose(state, dose.id, true, new Date(checkedAt.getTime() - 1000), photo), /AI 읽기 시간/);
  const late = { ...photo, reading: { ...reading, checkedAt: new Date(recordedAt.getTime() + 1000).toISOString() } };
  assert.throws(() => validateLoadedState({ ...recorded, doses: recorded.doses.map(item => item.id === dose.id ? { ...item, photo: late } : item) }));
});
