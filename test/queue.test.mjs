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

test('explicit generation mode generates, repairs once, stages declared files and redacts errors', async t => {
  const root = await fixture(t, [{ id: 'ai', code: undefined }]);
  let generated = 0;
  const outcome = await runQueue({ root, codeMode: 'generate', apiKey: 'private-test-key', generate: async job => { generated++; if (generated === 2) assert.ok(job.repairError.includes('[redacted]')); return 'export function render() {}'; }, render: async args => {
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

test('authored mode rejects enabled prompt-only jobs in planning and before injected rendering', async t => {
  const root = await fixture(t, [{ id: 'ai', code: undefined }, { id: 'disabled-ai', code: undefined, enabled: false }]);
  const plan = await inspectQueue({ root, codeMode: 'authored' });
  assert.deepEqual(plan.items.map(item => item.status), ['invalid', 'disabled']);
  assert.match(plan.items[0].error, /requires a committed code file in authored mode/);
  let generated = 0;
  let rendered = 0;
  const outcome = await runQueue({ root, codeMode: 'authored', generate: async () => { generated++; }, render: async () => { rendered++; } });
  assert.equal(outcome.failed, true);
  assert.deepEqual(outcome.report.results.map(item => item.status), ['invalid', 'disabled']);
  assert.equal(generated, 0);
  assert.equal(rendered, 0);
  assert.equal(outcome.stateChanged, false);
});

test('authored mode rejects manual prompts before creating or rendering a manual job', async t => {
  const root = await fixture(t, []);
  const options = { root, codeMode: 'authored', prompt: 'Make a new scene.', generate: () => assert.fail('generation must not run'), render: () => assert.fail('rendering must not run') };
  await assert.rejects(inspectQueue(options), /Authored mode does not accept manual prompts/);
  await assert.rejects(runQueue(options), /Authored mode does not accept manual prompts/);
  await assert.rejects(fs.stat(path.join(root, '.state/manual/job.json')), { code: 'ENOENT' });
});

test('authored code renders without credentials or calling generation, including after render failure', async t => {
  const root = await fixture(t, [{ id: 'a' }, { id: 'b' }]);
  const outcome = await runQueue({ root, codeMode: 'authored', generate: () => assert.fail('generation must not run'), render: async args => {
    assert.equal(args.job.code, 'examples/scene.mjs');
    assert.equal(await fs.readFile(path.join(args.staging, args.job.code), 'utf8'), 'export function render() {}');
    if (args.job.id === 'b') throw new Error('authored scene failed');
    await fakeRender(args);
  } });
  assert.deepEqual(outcome.report.results.map(item => item.status), ['completed', 'failed']);
  assert.equal(outcome.report.results[0].generated, false);
  assert.equal(outcome.report.results[0].attempts, 1);
  assert.equal(outcome.report.results[1].attempts, 1);
  assert.equal(outcome.failed, true);
});

test('code mode derives from the environment and rejects unsupported modes', async t => {
  const root = await fixture(t, [{ id: 'ai', code: undefined }]);
  const previous = process.env.VIDEO_CODE_MODE;
  t.after(() => { if (previous === undefined) delete process.env.VIDEO_CODE_MODE; else process.env.VIDEO_CODE_MODE = previous; });
  process.env.VIDEO_CODE_MODE = 'authored';
  assert.equal((await inspectQueue({ root })).items[0].status, 'invalid');
  process.env.VIDEO_CODE_MODE = 'generate';
  assert.equal((await inspectQueue({ root })).items[0].status, 'pending');
  await assert.rejects(inspectQueue({ root, codeMode: 'unsupported' }), /VIDEO_CODE_MODE must be authored or generate/);
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
