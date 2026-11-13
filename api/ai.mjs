import Anthropic from '@anthropic-ai/sdk';
import { carePool } from '../server/queue-runtime.mjs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// The SDK is imported here so Vercel bundles it with this function; the compiled handler only receives the client.
const require = createRequire(import.meta.url);
let handler;

export default {
  async fetch(request) {
    if (!process.env.DATABASE_URL) {
      return Response.json({ error: '공유 서버가 준비되지 않았어요.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
    if (!handler) {
      const { createVercelAiHandler } = require(resolve(process.cwd(), 'care-runtime/server/vercel-ai.js'));
      const { createClaudePouchReader } = require(resolve(process.cwd(), 'care-runtime/server/ai-pouch.js'));
      // Without a key the route answers 503 and the app records photos as usual. Only this key and the public endpoint are used.
      const apiKey = process.env.ANTHROPIC_API_KEY;
      const reader = apiKey
        ? createClaudePouchReader(new Anthropic({ apiKey, baseURL: 'https://api.anthropic.com' }), { model: process.env.CARE_AI_MODEL, effort: process.env.CARE_AI_EFFORT })
        : undefined;
      handler = createVercelAiHandler(carePool(), reader);
    }
    return handler(request);
  },
};
