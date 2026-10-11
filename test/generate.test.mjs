import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateCode, DEFAULT_MODEL, API_ENDPOINT, GENERATION_LIMITS } from '../src/generate.mjs';

const apiKey = 'test-private-key';
const job = { id: 'test-scene', prompt: 'Animate a blue planet with an orbiting moon.', width: 640, height: 360, fps: 24, duration: 8, assets: {} };
const source = 'export function render(ctx, {width,height,t}) { ctx.fillStyle = "navy"; ctx.fillRect(0,0,width,height); }';
const success = text => new Response(JSON.stringify({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text }] }] }), { status: 200 });

test('sends fixed Gemini request and extracts only final source', async () => {
  let request;
  const code = await generateCode({ ...job, assets: { logo: 'assets/logo.png' }, renderDate: '2026-10-11' }, {
    apiKey,
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ status: 'completed', steps: [
        { type: 'thought', content: [{ type: 'text', text: 'not executable source' }] },
        { type: 'model_output', content: [{ type: 'text', text: source }] },
      ] }));
    },
  });
  assert.equal(code, `${source}\n`);
  assert.equal(request.url, API_ENDPOINT);
  assert.equal(request.options.headers['x-goog-api-key'], apiKey);
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.body.model, DEFAULT_MODEL);
  assert.equal(request.body.service_tier, 'standard');
  assert.equal(request.body.store, false);
  assert.equal(request.body.background, false);
  assert.equal(request.body.stream, false);
  assert.equal(request.body.generation_config.max_output_tokens, 12000);
  assert.ok(!request.options.body.includes(apiKey));
  assert.match(request.body.input, /t and time are elapsed seconds/);
  assert.match(request.body.input, /"assetNames":\["logo"\]/);
  assert.match(request.body.input, /"renderDate":"2026-10-11"/);
  assert.ok(!request.body.input.includes('assets/logo.png'));
});

test('strips a surrounding JavaScript fence and accepts async named render', async () => {
  const asyncSource = 'export async function render(ctx, state) { ctx.fillRect(0,0,state.width,state.height); }';
  const code = await generateCode(job, { apiKey, fetchImpl: async () => success(`\`\`\`javascript\r\n${asyncSource}\r\n\`\`\``) });
  assert.equal(code, `${asyncSource}\n`);
});

test('includes prior scene and bounded repair diagnostic as task data', async () => {
  let input;
  await generateCode({ ...job, previousCode: source, repairError: 'x'.repeat(2500) }, {
    apiKey,
    fetchImpl: async (_url, options) => { input = JSON.parse(options.body).input; return success(source); },
  });
  const data = JSON.parse(input.slice(input.indexOf('\n\n{') + 2));
  assert.equal(data.previousCode, source);
  assert.equal(data.repairError.length, GENERATION_LIMITS.repairCharacters);
});

test('requires a key and bounds prompt before sending a request', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return success(source); };
  await assert.rejects(generateCode(job, { apiKey: '', fetchImpl }), /GEMINI_API_KEY/);
  await assert.rejects(generateCode({ ...job, prompt: 'x'.repeat(8001) }, { apiKey, fetchImpl }), /8,000/);
  await assert.rejects(generateCode({ ...job, prompt: ' ' }, { apiKey, fetchImpl }), /8,000/);
  assert.equal(calls, 0);
});

test('rejects truncated responses even when source would be valid', async () => {
  await assert.rejects(generateCode(job, {
    apiKey,
    fetchImpl: async () => new Response(JSON.stringify({ status: 'incomplete', steps: [{ type: 'model_output', content: [{ type: 'text', text: source }] }] })),
  }), /truncated/);
});

test('rejects source above 128 KiB and modules missing named render', async () => {
  await assert.rejects(generateCode(job, { apiKey, fetchImpl: async () => success(`${source}\n//${'x'.repeat(128 * 1024)}`) }), /128 KiB/);
  await assert.rejects(generateCode(job, { apiKey, fetchImpl: async () => success('export default () => {};') }), /export function render/);
});

test('syntax-checks source without executing it on the host', async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'generation-test-'));
  const marker = path.join(scratch, 'should-not-exist.txt');
  try {
    const scene = `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'executed'); ${source}`;
    await generateCode(job, { apiKey, fetchImpl: async () => success(scene) });
    await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
    await assert.rejects(generateCode(job, { apiKey, fetchImpl: async () => success('export function render(ctx,state) { invalid + }') }), /invalid JavaScript syntax/);
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
});

test('does not leak authentication response text or retry HTTP 401', async () => {
  let calls = 0;
  await assert.rejects(generateCode(job, {
    apiKey,
    fetchImpl: async () => { calls++; return new Response(`sensitive service body ${apiKey}`, { status: 401 }); },
  }), error => /authentication/.test(error.message) && !error.message.includes(apiKey) && !error.message.includes('sensitive'));
  assert.equal(calls, 1);
});

test('retries quota failures at most three times with a capped delay', async () => {
  const delays = [];
  let calls = 0;
  await assert.rejects(generateCode(job, {
    apiKey,
    fetchImpl: async () => { calls++; return new Response(`secret ${apiKey}`, { status: 429, headers: { 'retry-after': '999999' } }); },
    sleepImpl: async ms => delays.push(ms),
  }), /free AI quota/);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [10000, 10000]);
});

test('recovers from one transient HTTP failure with the same model', async () => {
  const models = [];
  const delays = [];
  const code = await generateCode(job, {
    apiKey,
    fetchImpl: async (_url, options) => { models.push(JSON.parse(options.body).model); return models.length === 1 ? new Response('', { status: 503 }) : success(source); },
    sleepImpl: async ms => delays.push(ms),
  });
  assert.equal(code, `${source}\n`);
  assert.deepEqual(models, [DEFAULT_MODEL, DEFAULT_MODEL]);
  assert.deepEqual(delays, [500]);
});

test('bounds retries and sanitizes transport exceptions', async () => {
  let calls = 0;
  await assert.rejects(generateCode(job, {
    apiKey,
    fetchImpl: async () => { calls++; throw new Error(`network exception ${apiKey}`); },
    sleepImpl: async () => {},
  }), error => /three attempts/.test(error.message) && !error.message.includes(apiKey));
  assert.equal(calls, 3);
});

test('aborts timed out requests with a fixed error', async () => {
  let calls = 0;
  await assert.rejects(generateCode(job, {
    apiKey,
    timeoutMs: 5,
    fetchImpl: async (_url, options) => {
      calls++;
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error(apiKey)), { once: true }));
    },
  }), error => /timed out/.test(error.message) && !error.message.includes(apiKey));
  assert.equal(calls, 1);
});

test('rejects malformed JSON and oversized transport body without logging it', async () => {
  await assert.rejects(generateCode(job, { apiKey, fetchImpl: async () => new Response(`malformed ${apiKey}`) }), /not valid JSON/);
  await assert.rejects(generateCode(job, { apiKey, fetchImpl: async () => new Response('x'.repeat(GENERATION_LIMITS.responseBytes + 1)) }), /allowed size/);
});

test('sanitizes streamed response failures', async () => {
  const stream = new ReadableStream({ start(controller) { controller.error(new Error(`stream body ${apiKey}`)); } });
  await assert.rejects(generateCode(job, { apiKey, fetchImpl: async () => new Response(stream) }),
    error => /could not be read/.test(error.message) && !error.message.includes(apiKey) && !error.message.includes('stream body'));
});
