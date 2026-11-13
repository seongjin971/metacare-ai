import type Anthropic from '@anthropic-ai/sdk';
import { normalizePouchReading, parsePouchImage, POUCH_READING_SCHEMA, type PouchReading } from '../shared/pouch-reading.ts';
import { HttpError } from './care-errors.ts';

export type PouchImage = ReturnType<typeof parsePouchImage>;
/** Resolves to null when the photo could not be read; throws when the AI service is unavailable. */
export type PouchReader = (image: PouchImage) => Promise<PouchReading | null>;
type PouchClient = Pick<Anthropic, 'beta'>;
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const POUCH_READ_REQUEST_LIMIT = 4_300_000;
const DEFAULT_MODEL = 'claude-opus-5-5';
const DEFAULT_EFFORT: Effort = 'low';
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

const SYSTEM_PROMPT = `You read photos of Korean pharmacy medicine pouches (약봉투, 약포지) for a family medication-reminder app.
Report only what is printed about when to take the medicine. Do not transcribe names, pharmacy details, drug names or any other text.

- slots: the dosing times printed or marked on this pouch. 아침 is morning, 점심 is noon, 저녁 is evening, 취침 전 or 자기 전 is bedtime. A pouch usually prints only its own time. When several times are printed and some are marked (checked, circled, highlighted or bold), return only the marked ones.
- mealTiming and minutesFromMeal: 식전 is before_meal, 식후 is after_meal, 식간 is between_meals; 식후 30분 gives 30.
- timesPerDay and daysSupply: from text such as 1일 3회 and 7일분.
- isPouch is false when the photo does not show a medicine pouch or packet.
Use not_printed, 0 or an empty list for anything that is not printed or not legible, and set confidence to low rather than guess.`;

/** Builds the Claude call. `client` may be a factory so a missing API key only fails the AI route. */
export function createClaudePouchReader(client: PouchClient | (() => Promise<PouchClient>), options: { model?: string; effort?: string } = {}): PouchReader {
  const model = options.model?.trim() || DEFAULT_MODEL;
  const effort = EFFORTS.find(value => value === options.effort?.trim()) ?? DEFAULT_EFFORT;
  let resolved: Promise<PouchClient> | undefined;
  const getClient = () => {
    if (typeof client !== 'function') return Promise.resolve(client);
    resolved ??= client().catch(error => { resolved = undefined; throw error; });
    return resolved;
  };
  return async image => {
    const anthropic = await getClient();
    const response = await anthropic.beta.messages.create({
      model,
      // The answer is a short JSON object; this leaves room for low-effort thinking and caps the cost of one call.
      max_tokens: 3000,
      // A policy decline is retried on the model's default fallback instead of ending the reading.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort, format: { type: 'json_schema', schema: POUCH_READING_SCHEMA } },
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } },
          { type: 'text', text: '이 약봉투에 인쇄된 복용 시간 정보를 읽어 주세요.' },
        ],
      }],
      // One attempt that ends before the app's 30-second wait (and Vercel's 45-second limit); the patient can retake.
    }, { timeout: 25_000, maxRetries: 0 });
    if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') return null;
    const text = response.content.find(block => block.type === 'text');
    if (!text || text.type !== 'text') return null;
    try { return normalizePouchReading(JSON.parse(text.text)); }
    catch { return null; }
  };
}

/**
 * Logs what names a failed reading (status, error type and code, request ID; never the photo or the
 * response text) and maps it to what the app can tell the patient. Billing, model or key problems
 * are not the patient's photo, so only an oversized request is reported as unreadable.
 */
function unavailable(error: unknown): HttpError {
  const failure = (error ?? {}) as { status?: unknown; type?: unknown; errorCode?: unknown; requestID?: unknown; name?: unknown; message?: unknown };
  const status = typeof failure.status === 'number' ? failure.status : undefined;
  const type = typeof failure.type === 'string' ? failure.type : undefined;
  console.warn('MetaCare AI: the pouch reading failed.', {
    status: status ?? null,
    type: type ?? null,
    errorCode: typeof failure.errorCode === 'string' ? failure.errorCode : null,
    requestID: typeof failure.requestID === 'string' ? failure.requestID : null,
    // Without a status the SDK failed locally (no credential, connection, timeout); its message names that.
    ...(status === undefined && { name: String(failure.name ?? 'Error'), message: typeof failure.message === 'string' ? failure.message : null }),
  });
  if (status === 413 || type === 'request_too_large') return new HttpError(422, '사진이 커서 AI가 읽을 수 없어요.');
  if (status === 429 || status === 529 || type === 'rate_limit_error' || type === 'overloaded_error') {
    return new HttpError(503, 'AI 사용량이 많아요. 잠시 후 다시 시도해 주세요.');
  }
  return new HttpError(503, 'AI 사진 읽기를 지금 사용할 수 없어요.');
}

/** A well-formed request body: exactly one JPEG or PNG camera photo. */
export function parsePouchReadBody(body: unknown): PouchImage {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'image')) {
    throw new HttpError(400, '사진을 확인할 수 없어요.');
  }
  let image: PouchImage;
  try { image = parsePouchImage((body as { image?: unknown }).image); }
  catch (error) { throw new HttpError(400, error instanceof Error ? error.message : '사진을 확인할 수 없어요.'); }
  const bytes = Buffer.from(image.data, 'base64');
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = [0x89, 0x50, 0x4e, 0x47].every((byte, index) => bytes[index] === byte);
  if ((image.mediaType === 'image/jpeg' && !jpeg) || (image.mediaType === 'image/png' && !png)) throw new HttpError(400, '사진 형식을 확인할 수 없어요.');
  return image;
}

/**
 * POST /v1/ai/pouch-read. The photo is only forwarded to the model; nothing is stored.
 * `beforeRead` runs for a well-formed photo only, so malformed requests cannot use up daily limits.
 */
export async function routePouchRead(body: unknown, reader: PouchReader | undefined, beforeRead?: () => Promise<void>): Promise<{ status: number; body: { reading: PouchReading | null } }> {
  if (!reader) throw new HttpError(503, 'AI 사진 읽기가 설정되지 않았어요.');
  const image = parsePouchReadBody(body);
  await beforeRead?.();
  try {
    return { status: 200, body: { reading: await reader(image) } };
  } catch (error) {
    throw unavailable(error);
  }
}
