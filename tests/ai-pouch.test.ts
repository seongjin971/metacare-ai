import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import type { Pool } from 'pg';
import { createClaudePouchReader, routePouchRead, type PouchReader } from '../server/ai-pouch.ts';
import { startCareServer } from '../server/care-server.ts';
import { addressBucket, createVercelAiHandler } from '../server/vercel-ai.ts';
import { MAX_POUCH_IMAGE_BYTES, normalizePouchReading, parsePouchImage, POUCH_READING_SCHEMA, type PouchReading } from '../shared/pouch-reading.ts';

// Synthetic bytes with real JPEG/PNG signatures; no image leaves the test.
const JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]).toString('base64')}`;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const READING: PouchReading = {
  isPouch: true, slots: ['evening'], mealTiming: 'after_meal', minutesFromMeal: 30,
  timesPerDay: 3, daysSupply: 7, photoQuality: 'clear', confidence: 'high',
};

type CreateCall = { params: Record<string, unknown>; options: Record<string, unknown> };
function fakeClaude(respond: () => unknown) {
  const calls: CreateCall[] = [];
  const client = { beta: { messages: { create: async (params: Record<string, unknown>, options: Record<string, unknown>) => {
    calls.push({ params, options });
    return respond();
  } } } } as unknown as Pick<Anthropic, 'beta'>;
  return { client, calls };
}
const answer = (text: string, stop_reason = 'end_turn') => ({ stop_reason, content: [{ type: 'thinking', thinking: '' }, { type: 'text', text }] });

test('a reading must match the schema exactly, and only an empty list is kept for a photo that is not a pouch', () => {
  assert.deepEqual(normalizePouchReading(READING), READING);
  assert.deepEqual(normalizePouchReading({ ...READING, slots: ['evening', 'morning'] }).slots, ['morning', 'evening']);
  // Structured outputs cannot forbid repeats, so they are folded rather than losing a good reading.
  assert.deepEqual(normalizePouchReading({ ...READING, slots: ['noon', 'noon'] }).slots, ['noon']);
  assert.deepEqual(normalizePouchReading({ ...READING, isPouch: false }).slots, []);
  assert.deepEqual(Object.keys(POUCH_READING_SCHEMA.properties).sort(), [...POUCH_READING_SCHEMA.required].sort());
  for (const invalid of [
    null, [], { ...READING, name: '홍길동' }, { ...READING, slots: ['dinner'] }, { ...READING, slots: Array(17).fill('noon') },
    { ...READING, timesPerDay: 2.5 }, { ...READING, daysSupply: -1 }, { ...READING, confidence: 'certain' },
  ]) assert.throws(() => normalizePouchReading(invalid));
  assert.deepEqual(parsePouchImage(PNG).mediaType, 'image/png');
  for (const invalid of ['', 'data:image/gif;base64,R0lGOD', 'https://example.com/a.jpg', 'data:image/jpeg;base64,abc', 42]) {
    assert.throws(() => parsePouchImage(invalid));
  }
  assert.throws(() => parsePouchImage(`data:image/jpeg;base64,${'A'.repeat(Math.ceil(MAX_POUCH_IMAGE_BYTES / 3) * 4 + 4)}`), /용량/);
});

test('the Claude request sends the photo with the reading schema, the default fallback and no record of the expected dose', async () => {
  const { client, calls } = fakeClaude(() => answer(JSON.stringify(READING)));
  const reader = createClaudePouchReader(client);
  assert.deepEqual(await reader(parsePouchImage(JPEG)), READING);
  const { params, options } = calls[0];
  assert.equal(params.model, 'claude-opus-5-5');
  assert.equal(params.max_tokens, 3000);
  assert.equal('thinking' in params, false);
  assert.deepEqual(params.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(params.fallbacks, 'default');
  assert.deepEqual(params.output_config, { effort: 'low', format: { type: 'json_schema', schema: POUCH_READING_SCHEMA } });
  const [image, text] = (params.messages as { content: Array<Record<string, unknown>> }[])[0].content;
  assert.deepEqual(image, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPEG.split(',')[1] } });
  assert.doesNotMatch(String(text.text), /아침|점심|저녁/);
  // One attempt that ends before the app stops waiting at 30 seconds.
  assert.equal(options.timeout, 25_000);
  assert.equal(options.maxRetries, 0);

  const tuned = fakeClaude(() => answer(JSON.stringify(READING)));
  await createClaudePouchReader(tuned.client, { model: 'claude-sonnet-5-5', effort: 'medium' })(parsePouchImage(PNG));
  assert.equal(tuned.calls[0].params.model, 'claude-sonnet-5-5');
  assert.equal((tuned.calls[0].params.output_config as { effort: string }).effort, 'medium');
  const unknownEffort = fakeClaude(() => answer(JSON.stringify(READING)));
  await createClaudePouchReader(unknownEffort.client, { effort: 'extreme' })(parsePouchImage(PNG));
  assert.equal((unknownEffort.calls[0].params.output_config as { effort: string }).effort, 'low');
});

test('a declined, cut-off or malformed answer is an unreadable photo, not an error', async () => {
  for (const response of [
    answer(JSON.stringify(READING), 'refusal'), answer('{"isPouch":', 'max_tokens'), answer('not json'),
    answer(JSON.stringify({ ...READING, slots: ['lunch'] })), { stop_reason: 'end_turn', content: [] },
  ]) {
    const { client } = fakeClaude(() => response);
    assert.equal(await createClaudePouchReader(client)(parsePouchImage(JPEG)), null);
  }
});

test('the client factory runs once, and a missing credential only fails the AI route', async t => {
  t.mock.method(console, 'warn', () => undefined);
  let built = 0;
  const { client } = fakeClaude(() => answer(JSON.stringify(READING)));
  const reader = createClaudePouchReader(async () => { built += 1; return client; });
  await reader(parsePouchImage(JPEG));
  await reader(parsePouchImage(JPEG));
  assert.equal(built, 1);
  const broken = createClaudePouchReader(async () => { throw new Error('ANTHROPIC_API_KEY is missing'); });
  await assert.rejects(routePouchRead({ image: JPEG }, broken), (error: { status?: number }) => error.status === 503);
});

test('the AI route accepts one camera photo and turns provider failures into messages the app can show', async t => {
  const warnings = t.mock.method(console, 'warn', () => undefined);
  const reader: PouchReader = async () => READING;
  assert.deepEqual(await routePouchRead({ image: JPEG }, reader), { status: 200, body: { reading: READING } });
  assert.deepEqual(await routePouchRead({ image: PNG }, async () => null), { status: 200, body: { reading: null } });
  await assert.rejects(routePouchRead({ image: JPEG }, undefined), (error: { status?: number }) => error.status === 503);
  let counted = 0;
  const count = async () => { counted += 1; };
  for (const body of [null, [], {}, { image: JPEG, slot: 'evening' }, { image: 'data:image/jpeg;base64,iVBORw0KGgo=' }]) {
    await assert.rejects(routePouchRead(body, reader, count), (error: { status?: number }) => error.status === 400);
  }
  assert.equal(counted, 0, 'a malformed request never reaches the daily limits');
  await routePouchRead({ image: JPEG }, reader, count);
  assert.equal(counted, 1);

  const failing = (fields: Record<string, unknown>) => async () => { throw Object.assign(new Error('provider'), fields); };
  for (const [fields, expected, message] of [
    [{ status: 429, type: 'rate_limit_error' }, 503, /사용량/], [{ status: 529, type: 'overloaded_error' }, 503, /사용량/],
    [{ status: 413, type: 'request_too_large' }, 422, /사진이 커서/], [{ status: 400, type: 'invalid_request_error' }, 503, /사용할 수 없어요/],
    [{ status: 402, type: 'billing_error' }, 503, /사용할 수 없어요/], [{ status: 404, type: 'not_found_error' }, 503, /사용할 수 없어요/],
    [{ status: 401 }, 503, /사용할 수 없어요/], [{}, 503, /사용할 수 없어요/],
  ] as const) {
    await assert.rejects(routePouchRead({ image: JPEG }, failing(fields)), (error: { status?: number; message: string }) =>
      error.status === expected && message.test(error.message));
  }
  // Every failure is logged by what names it, never by the photo.
  assert.equal(warnings.mock.callCount(), 8);
  const logged = JSON.stringify(warnings.mock.calls.map(call => call.arguments));
  assert.match(logged, /"status":402,"type":"billing_error"/);
  assert.doesNotMatch(logged, new RegExp(JPEG.split(',')[1].slice(0, 12)));
});

async function localServer(t: TestContext, options: Parameters<typeof startCareServer>[0] = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'metacare-care-'));
  const running = await startCareServer({ port: 0, host: '127.0.0.1', dataPath: join(directory, 'care.json'), ...options });
  t.after(async () => { await running.close(); await rm(directory, { recursive: true, force: true }); });
  // null sends no body.
  return (method = 'POST', body: unknown = { image: JPEG }, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${running.port}/v1/ai/pouch-read`, {
    method, headers: { ...(body === null ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === null ? {} : { body: JSON.stringify(body) }),
  });
}

test('the local server reads a photo, limits each address separately from pairing, and checks the origin', async t => {
  const request = await localServer(t, { pouchReader: async () => READING, aiRateLimit: { maxRequests: 2, windowMs: 60_000 } });
  const first = await request('POST', { image: JPEG }, { Origin: 'http://localhost:8081' });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('access-control-allow-origin'), 'http://localhost:8081');
  assert.deepEqual(await first.json(), { reading: READING });
  assert.equal((await request('GET', null)).status, 405);
  assert.equal((await request()).status, 200);
  const limited = await request();
  assert.equal(limited.status, 429);
  assert.match((await limited.json()).error, /AI 사진 읽기 요청이 너무 많아요/);
  assert.equal((await request('POST', { image: JPEG }, { Origin: 'https://evil.example' })).status, 403);
  const unconfigured = await localServer(t);
  assert.equal((await unconfigured()).status, 503);
});

function fakePool(hits: (key: string) => number = () => 1) {
  const keys: string[] = [];
  const pool = { query: async (sql: string, params: unknown[]) => {
    if (!sql.trim().startsWith('INSERT')) return { rows: [] };
    keys.push(String(params[0]));
    return { rows: [{ hits: hits(String(params[0])) }] };
  } } as unknown as Pool;
  return { pool, keys };
}

const vercelPost = (url: string, body: unknown = { image: JPEG }, headers: Record<string, string> = {}) => new Request(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-vercel-forwarded-for': '203.0.113.7', ...headers }, body: JSON.stringify(body),
});

test('an IPv6 address shares its limits with the rest of its /64', () => {
  assert.equal(addressBucket('203.0.113.7'), '203.0.113.7');
  assert.equal(addressBucket('2001:db8:1:2::1'), '2001:0db8:0001:0002::/64');
  assert.equal(addressBucket('2001:DB8:1:2:ffff:ffff:ffff:ffff'), addressBucket('2001:db8:1:2::'));
  assert.notEqual(addressBucket('2001:db8:1:3::1'), addressBucket('2001:db8:1:2::1'));
  assert.equal(addressBucket('::ffff:203.0.113.7'), '::ffff:203.0.113.7');
  assert.equal(addressBucket(''), 'unknown');
  assert.equal(addressBucket('not-an-ip'), 'unknown');
});

test('the Vercel AI function counts every attempt per address, and a well-formed photo per address and day', async () => {
  const origin = 'https://metacare-demo.vercel.app';
  const address = createHash('sha256').update('203.0.113.7').digest('hex');
  const { pool, keys } = fakePool();
  const handle = createVercelAiHandler(pool, async () => READING, { allowedOrigins: [origin], dailyLimit: 5 });
  const rewritten = await handle(vercelPost('https://metacare.vercel.app/api/ai?aiRoute=pouch-read', { image: JPEG }, { Origin: origin }));
  assert.equal(rewritten.status, 200);
  assert.equal(rewritten.headers.get('access-control-allow-origin'), origin);
  assert.deepEqual(await rewritten.json(), { reading: READING });
  assert.deepEqual(keys, [`ai:${address}`, `ai-day:${address}`, 'ai:day']);
  keys.length = 0;
  assert.equal((await handle(new Request('https://metacare.vercel.app/v1/ai/pouch-read', { method: 'POST', headers: { 'x-vercel-forwarded-for': '203.0.113.7' } }))).status, 415);
  assert.equal((await handle(vercelPost('https://metacare.vercel.app/v1/ai/pouch-read', { image: 'data:image/jpeg;base64,iVBORw0KGgo=' }))).status, 400);
  assert.deepEqual(keys, [`ai:${address}`, `ai:${address}`], 'malformed requests count only against the short per-address limit');
  assert.equal((await handle(vercelPost('https://metacare.vercel.app/v1/ai/pouch-read'))).status, 200);
  const preflight = await handle(new Request('https://metacare.vercel.app/api/ai?aiRoute=pouch-read', { method: 'OPTIONS', headers: { Origin: origin } }));
  assert.equal(preflight.status, 204);
  assert.equal((await handle(vercelPost('https://metacare.vercel.app/api/ai?aiRoute=other'))).status, 404);
  assert.equal((await handle(vercelPost('https://metacare.vercel.app/api/ai?aiRoute=pouch-read', { image: JPEG }, { Origin: 'https://evil.example' }))).status, 403);
  assert.equal((await handle(new Request('https://metacare.vercel.app/v1/ai/pouch-read', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' }))).status, 415);

  const perAddress = createVercelAiHandler(fakePool(key => key.startsWith('ai:') && key !== 'ai:day' ? 21 : 1).pool, async () => READING);
  const busy = await perAddress(vercelPost('https://metacare.vercel.app/v1/ai/pouch-read'));
  assert.equal(busy.status, 429);
  assert.match((await busy.json()).error, /요청이 너무 많아요/);
  const perAddressDay = createVercelAiHandler(fakePool(key => key.startsWith('ai-day:') ? 31 : 1).pool, async () => READING);
  const used = await perAddressDay(vercelPost('https://metacare.vercel.app/v1/ai/pouch-read'));
  assert.equal(used.status, 429);
  assert.match((await used.json()).error, /요청이 너무 많아요/);
  const daily = createVercelAiHandler(fakePool(key => key === 'ai:day' ? 6 : 1).pool, async () => READING, { dailyLimit: 5 });
  const spent = await daily(vercelPost('https://metacare.vercel.app/v1/ai/pouch-read'));
  assert.equal(spent.status, 429);
  assert.match((await spent.json()).error, /오늘 AI 사진 읽기 한도/);
  assert.equal((await createVercelAiHandler(fakePool().pool, undefined)(vercelPost('https://metacare.vercel.app/v1/ai/pouch-read'))).status, 503);
});
