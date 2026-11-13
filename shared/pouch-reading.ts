/** What an AI reading of a medicine pouch photo may contain. It has no field for names or drug names. */
export const POUCH_READ_PATH = '/v1/ai/pouch-read';
/** Decoded image bytes; a 1080p camera JPEG is far smaller. Base64 plus JSON stays under Vercel's 4.5 MB request limit. */
export const MAX_POUCH_IMAGE_BYTES = 3 * 1024 * 1024;

export const POUCH_SLOTS = ['morning', 'noon', 'evening', 'bedtime'] as const;
export type PouchSlot = typeof POUCH_SLOTS[number];
const MEAL_TIMINGS = ['before_meal', 'after_meal', 'between_meals', 'not_printed'] as const;
const PHOTO_QUALITIES = ['clear', 'blurry', 'dark', 'glare', 'cut_off'] as const;
const CONFIDENCES = ['high', 'medium', 'low'] as const;

export type PouchReading = {
  isPouch: boolean;
  /** Dosing times printed or marked on this pouch. */
  slots: PouchSlot[];
  mealTiming: typeof MEAL_TIMINGS[number];
  /** 0 when not printed. */
  minutesFromMeal: number;
  /** 0 when not printed. */
  timesPerDay: number;
  /** 0 when not printed. */
  daysSupply: number;
  photoQuality: typeof PHOTO_QUALITIES[number];
  confidence: typeof CONFIDENCES[number];
};

/** The structured-output schema sent to Claude. */
export const POUCH_READING_SCHEMA = {
  type: 'object',
  properties: {
    isPouch: { type: 'boolean', description: 'Whether the photo shows a medicine pouch or packet.' },
    slots: { type: 'array', items: { type: 'string', enum: [...POUCH_SLOTS] }, description: 'Dosing times printed or marked on this pouch.' },
    mealTiming: { type: 'string', enum: [...MEAL_TIMINGS] },
    minutesFromMeal: { type: 'integer', description: 'Minutes before or after a meal as printed, such as 30 for 식후 30분; 0 when not printed.' },
    timesPerDay: { type: 'integer', description: 'Doses per day as printed, such as 3 for 1일 3회; 0 when not printed.' },
    daysSupply: { type: 'integer', description: 'Days supplied as printed, such as 7 for 7일분; 0 when not printed.' },
    photoQuality: { type: 'string', enum: [...PHOTO_QUALITIES] },
    confidence: { type: 'string', enum: [...CONFIDENCES], description: 'How sure the dosing-time reading is.' },
  },
  required: ['isPouch', 'slots', 'mealTiming', 'minutesFromMeal', 'timesPerDay', 'daysSupply', 'photoQuality', 'confidence'],
  additionalProperties: false,
} as const;

const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === 'string' && (values as readonly string[]).includes(value);
const count = (value: unknown, maximum: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= maximum;

/** Checks a reading from the model or the server. Throws when anything is off. */
export function normalizePouchReading(value: unknown): PouchReading {
  const invalid = () => new Error('AI 읽기 결과를 확인할 수 없어요.');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const reading = value as Record<string, unknown>;
  const keys = Object.keys(POUCH_READING_SCHEMA.properties);
  if (Object.keys(reading).some(key => !keys.includes(key))) throw invalid();
  // Structured outputs cannot forbid repeated items, so repeats are folded below instead of rejected.
  if (typeof reading.isPouch !== 'boolean' || !Array.isArray(reading.slots) || reading.slots.length > 16
    || !reading.slots.every(slot => oneOf(POUCH_SLOTS, slot))
    || !oneOf(MEAL_TIMINGS, reading.mealTiming) || !count(reading.minutesFromMeal, 240) || !count(reading.timesPerDay, 12)
    || !count(reading.daysSupply, 365) || !oneOf(PHOTO_QUALITIES, reading.photoQuality) || !oneOf(CONFIDENCES, reading.confidence)) {
    throw invalid();
  }
  return {
    isPouch: reading.isPouch,
    // A photo that is not a pouch has no dosing time to report.
    slots: reading.isPouch ? POUCH_SLOTS.filter(slot => (reading.slots as unknown[]).includes(slot)) : [],
    mealTiming: reading.mealTiming,
    minutesFromMeal: reading.minutesFromMeal,
    timesPerDay: reading.timesPerDay,
    daysSupply: reading.daysSupply,
    photoQuality: reading.photoQuality,
    confidence: reading.confidence,
  };
}

/** A camera photo as a base64 data URL, within the size the AI route accepts. */
export function parsePouchImage(value: unknown): { mediaType: 'image/jpeg' | 'image/png'; data: string } {
  const match = typeof value === 'string' && value.length <= Math.ceil(MAX_POUCH_IMAGE_BYTES / 3) * 4 + 40
    ? /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value) : null;
  if (!match || match[2].length % 4 !== 0) throw new Error('사진 형식을 확인할 수 없어요.');
  const data = match[2];
  const bytes = data.length * 3 / 4 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
  if (bytes <= 0 || bytes > MAX_POUCH_IMAGE_BYTES) throw new Error('사진 용량을 확인해 주세요.');
  return { mediaType: match[1] as 'image/jpeg' | 'image/png', data };
}
