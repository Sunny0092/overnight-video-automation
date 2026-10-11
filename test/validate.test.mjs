import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateJobData, loadJob, resolveLocalFile } from '../src/validate.mjs';

const base = { id: 'test', prompt: 'Animate an original scene.', code: 'scene.mjs' };

test('fills practical defaults and allows prompt-only jobs only when requested', () => {
  assert.deepEqual(validateJobData(base), { width: 1280, height: 720, fps: 24, duration: 12, enabled: true, ...base });
  assert.throws(() => validateJobData({ id: 'idea', prompt: 'Motion.' }), /code/);
  assert.equal(validateJobData({ id: 'idea', prompt: 'Motion.' }, { requireCode: false }).code, undefined);
});

test('rejects unsafe filenames and excessive render workloads; accepts portrait', () => {
  for (const id of ['../oops', 'A', 'a/b', 'a'.repeat(65)]) assert.throws(() => validateJobData({ ...base, id }), /id/);
  for (const changes of [{ width: 1279 }, { height: 2000 }, { width: 1920, height: 1920 }, { fps: 61 }, { duration: 121 }, { enabled: 'yes' }, { assets: { logo: 'x', constructor: 'x' } }]) assert.throws(() => validateJobData({ ...base, ...changes }));
  assert.equal(validateJobData({ ...base, width: 1080, height: 1920 }).height, 1920);
});

test('rejects traversal, URLs, symlink escapes and missing files without importing scene', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'video-validation-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'repo');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'scene.mjs'), 'throw new Error("must never execute during validation");');
  await fs.writeFile(path.join(root, 'job.json'), JSON.stringify(base));
  const loaded = await loadJob('job.json', root);
  assert.equal(loaded.codePath, path.join(root, 'scene.mjs'));
  for (const location of ['../scene.mjs', 'a/../scene.mjs', 'https://example.com/x.mjs', 'C:\\secret.mjs', '\\\\server\\secret.mjs', '/secret.mjs']) await assert.rejects(resolveLocalFile(root, location, new Set(['.mjs']), 'code'));
  await assert.rejects(resolveLocalFile(root, 'missing.mjs', new Set(['.mjs']), 'code'), /ENOENT/);
  const outside = path.join(temporary, 'outside.mjs');
  await fs.writeFile(outside, 'export function render() {}');
  try { await fs.symlink(outside, path.join(root, 'link.mjs')); }
  catch (error) {
    if (error.code === 'EPERM') { t.diagnostic('Windows symlink privilege unavailable; path traversal checks still ran.'); return; }
    throw error;
  }
  await assert.rejects(resolveLocalFile(root, 'link.mjs', new Set(['.mjs']), 'code'), /outside/);
});
