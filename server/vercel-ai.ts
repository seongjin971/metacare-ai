import { isIP } from 'node:net';
import type { Pool } from 'pg';
import { POUCH_READ_PATH } from '../shared/pouch-reading.ts';
import { POUCH_READ_REQUEST_LIMIT, routePouchRead, type PouchReader } from './ai-pouch.ts';
import { hash } from './care-core.ts';
import { HttpError } from './care-errors.ts';
import { countAttempt, isDeployedWebOrigin, readBody } from './vercel-care.ts';

const tenMinutes = 10 * 60_000;
const oneDay = 24 * 60 * 60_000;
const DEFAULT_DAILY_LIMIT = 500;
/** One address can never use up the whole day's readings for everyone else. */
const DAILY_LIMIT_PER_ADDRESS = 30;

/** An IPv6 user can rotate addresses inside their /64, so the whole /64 shares one bucket. */
export function addressBucket(ip: string): string {
  const version = isIP(ip);
  if (version === 4 || (version === 6 && ip.includes('.'))) return ip;
  if (version !== 6) return 'unknown';
  const [head, tail] = ip.split('%')[0].split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return `${groups.slice(0, 4).map(group => group.toLowerCase().padStart(4, '0')).join(':')}::/64`;
}

type Options = { now?: () => number; allowedOrigins?: string[]; dailyLimit?: number };

function aiPath(request: Request): string {
  const url = new URL(request.url);
  const query = [...url.searchParams];
  // Depending on the runtime adapter, the function sees the rewrite destination or the external path.
  if (query.length === 1 && query[0][0] === 'aiRoute') {
    const path = '/v1/ai/' + query[0][1];
    if (!/^\/v1\/ai\/[A-Za-z0-9_-]+$/.test(path) || (url.pathname !== '/api/ai' && url.pathname !== path)) throw new HttpError(400, 'Invalid route.');
    return path;
  }
  if (query.length) throw new HttpError(400, 'Query parameters are not supported.');
  return url.pathname;
}

/**
 * The AI route runs in its own function so the Anthropic SDK ships with it. Every attempt counts
 * against a short per-address limit; a well-formed photo also counts against a daily limit per
 * address and a daily total before it reaches the model.
 */
export function createVercelAiHandler(pool: Pool, reader: PouchReader | undefined, options: Options = {}) {
  const now = options.now ?? Date.now;
  const configuredOrigins = [process.env.CARE_ALLOWED_ORIGINS, process.env.CARE_WEB_PREVIEW_ORIGINS]
    .flatMap(value => value?.split(',') ?? []).map(value => value.trim()).filter(Boolean);
  const origins = new Set((options.allowedOrigins ?? configuredOrigins).filter(isDeployedWebOrigin));
  const configuredDaily = Number(process.env.CARE_AI_DAILY_LIMIT);
  const dailyLimit = options.dailyLimit ?? (Number.isInteger(configuredDaily) && configuredDaily > 0 ? configuredDaily : DEFAULT_DAILY_LIMIT);
  return async function handle(request: Request): Promise<Response> {
    const headers = new Headers({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Vary': 'Origin' });
    try {
      const origin = request.headers.get('origin');
      if (origin !== null) {
        if (!origins.has(origin)) throw new HttpError(403, 'Origin is not allowed.');
        headers.set('Access-Control-Allow-Origin', origin);
        headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
        headers.set('Access-Control-Allow-Headers', 'Content-Type');
      }
      if (aiPath(request) !== POUCH_READ_PATH) throw new HttpError(404, 'Route not found.');
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
      if (request.method !== 'POST') throw new HttpError(405, 'Use POST.');
      const timestamp = now();
      // Vercel populates this header at its edge. Local tests without it share a single bucket.
      const address = hash(addressBucket(request.headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim() ?? ''));
      const busy = 'AI 사진 읽기 요청이 너무 많아요. 잠시 후 다시 시도해 주세요.';
      await pool.query('DELETE FROM metacare_rate_limits WHERE reset_at <= $1', [new Date(timestamp)]);
      // Every attempt counts here, before the body is read, so floods of malformed requests stay cheap.
      await countAttempt(pool, 'ai:' + address, timestamp, 20, tenMinutes, busy);
      const result = await routePouchRead(await readBody(request, POUCH_READ_REQUEST_LIMIT), reader, async () => {
        await countAttempt(pool, 'ai-day:' + address, timestamp, DAILY_LIMIT_PER_ADDRESS, oneDay, busy);
        await countAttempt(pool, 'ai:day', timestamp, dailyLimit, oneDay, '오늘 AI 사진 읽기 한도를 다 썼어요. 내일 다시 시도해 주세요.');
      });
      return Response.json(result.body, { status: result.status, headers });
    } catch (error) {
      const known = error instanceof HttpError;
      return Response.json({ error: known ? error.message : 'AI 사진 읽기를 지금 사용할 수 없어요.' }, { status: known ? error.status : 503, headers });
    }
  };
}
