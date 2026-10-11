import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { dockerArguments, indiaDate, inspectQueue, runQueue } from '../src/queue.mjs';

async function fixture(t, jobs) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-queue-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'jobs'));
  await fs.mkdir(path.join(root, 'examples'));
  await fs.writeFile(path.join(root, 'examples/scene.mjs'), 'export function render() {}');
  for (const job of jobs) await fs.writeFile(path.join(root, 'jobs', `${job.id}.json`), JSON.stringify({ prompt: 'Draw a circle.', code: 'examples/scene.mjs', ...job }));
  return root;
}

const fakeRender = async ({ job, output }) => {
  await fs.writeFile(path.join(output, `${job.id}.mp4`), 'fake-mp4-for-queue-unit-test');
  await fs.writeFile(path.join(output, `${job.id}-poster.png`), 'fake-poster-for-queue-unit-test');
  await fs.writeFile(path.join(output, `${job.id}-manifest.json`), JSON.stringify({ id: job.id }));
};

test('completed jobs skip unchanged; force and code changes render again', async t => {
  const root = await fixture(t, [{ id: 'demo' }]);
  assert.equal((await runQueue({ root, render: fakeRender })).report.results[0].status, 'completed');
  assert.equal((await inspectQueue({ root })).items[0].status, 'unchanged');
  assert.equal((await inspectQueue({ root, force: true })).items[0].status, 'pending');
  await fs.writeFile(path.join(root, 'examples/scene.mjs'), 'export function render() { return 1; }');
  assert.equal((await inspectQueue({ root })).items[0].status, 'pending');
});

test('partial failures preserve successful markers and continue later jobs', async t => {
  const root = await fixture(t, [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]);
  const outcome = await runQueue({ root, render: async args => { if (args.job.id === 'b') throw new Error('scene failed'); await fakeRender(args); } });
  assert.equal(outcome.failed, true);
  assert.equal(outcome.stateChanged, true);
  assert.deepEqual(outcome.report.results.map(item => item.status), ['completed', 'failed', 'completed', 'deferred']);
  const next = await inspectQueue({ root });
  assert.deepEqual(next.items.map(item => item.status), ['unchanged', 'pending', 'unchanged', 'pending']);
});

test('daily jobs become pending on the next date in India', async t => {
  assert.equal(indiaDate(new Date('2026-10-11T20:07:00Z')), '2026-10-12');
  const root = await fixture(t, [{ id: 'daily', repeat: 'daily' }]);
  await runQueue({ root, render: fakeRender, now: new Date('2026-10-11T20:07:00Z') });
  assert.equal((await inspectQueue({ root, now: new Date('2026-10-12T04:00:00Z') })).items[0].status, 'unchanged');
  assert.equal((await inspectQueue({ root, now: new Date('2026-10-12T20:07:00Z') })).items[0].status, 'pending');
});

test('prompt jobs generate, repair once, stage declared files and redact errors', async t => {
  const root = await fixture(t, [{ id: 'ai', code: undefined }]);
  let generated = 0;
  const outcome = await runQueue({ root, apiKey: 'private-test-key', generate: async job => { generated++; if (generated === 2) assert.ok(job.repairError.includes('[redacted]')); return 'export function render() {}'; }, render: async args => {
    const staged = JSON.parse(await fs.readFile(path.join(args.staging, 'jobs/job.json'), 'utf8'));
    assert.equal(staged.code, 'generated/scene.mjs');
    assert.equal(await fs.stat(path.join(args.staging, 'generated/scene.mjs')).then(s => s.isFile()), true);
    if (args.attempts === 1) throw new Error('bad scene private-test-key');
    await fakeRender(args);
  } });
  assert.equal(generated, 2);
  assert.equal(outcome.report.results[0].attempts, 2);
  assert.equal(outcome.failed, false);
  assert.ok((await fs.readFile(path.join(root, 'out/ai/ai-scene.mjs'), 'utf8')).includes('render'));
});

test('Docker arguments isolate scene code and never forward host credentials', () => {
  const args = dockerArguments({ staging: '/tmp/scene', output: '/tmp/out', image: 'renderer', containerName: 'scene' });
  for (const flag of ['--read-only', '--cap-drop', '--pids-limit', '--user', '--memory', '--network']) assert.ok(args.includes(flag));
  assert.ok(args.includes('none'));
  assert.ok(args.includes('1000:1000'));
  assert.ok(args.includes('type=bind,src=/tmp/scene,dst=/workspace,readonly'));
  assert.equal(args.some(arg => arg.includes('GEMINI_API_KEY') || arg === '--env' || arg === '-e'), false);
});

test('only regular expected output files survive artifact preparation', async t => {
  const root = await fixture(t, [{ id: 'demo' }]);
  const result = await runQueue({ root, render: async args => {
    await fakeRender(args);
    await fs.mkdir(path.join(args.output, 'unexpected'));
    await fs.writeFile(path.join(args.output, 'unexpected/large.txt'), 'discard');
    await fs.writeFile(path.join(args.output, 'secret.txt'), 'discard');
  } });
  assert.equal(result.failed, false);
  assert.deepEqual((await fs.readdir(path.join(root, 'out/demo'))).sort(), ['demo-manifest.json', 'demo-poster.png', 'demo.mp4']);
});
