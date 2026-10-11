import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCanvas } from '@napi-rs/canvas';
import { buildFfmpegArgs, parseArgs, renderJob } from '../src/render.mjs';
import { render } from '../examples/demo.mjs';

test('demo draws all three scenes with different opaque frames', () => {
  const canvas = createCanvas(640, 360);
  const ctx = canvas.getContext('2d');
  const checksums = [];
  for (const time of [2, 6, 10.5]) {
    render(ctx, { width: 640, height: 360, t: time, time, duration: 12, progress: time / 12 });
    const data = ctx.getImageData(0, 0, 640, 360).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) { sum += data[i] + data[i + 1] + data[i + 2]; assert.equal(data[i + 3], 255); }
    checksums.push(sum);
  }
  assert.equal(new Set(checksums).size, 3);
});

test('encoder arguments produce a bounded H.264 MP4 with optional looped audio', () => {
  const job = { width: 1280, height: 720, fps: 24, duration: 12 };
  const args = buildFfmpegArgs(job, 'output.mp4');
  assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
  assert.equal(args[args.indexOf('-pix_fmt') + 1], 'yuv420p');
  assert.equal(args[args.indexOf('-movflags') + 1], '+faststart');
  assert.ok(args.includes('-an'));
  const audioArgs = buildFfmpegArgs(job, 'output.mp4', 'assets/music.wav');
  assert.ok(audioArgs.includes('assets/music.wav'));
  assert.ok(audioArgs.includes('-stream_loop'));
  assert.equal(audioArgs[audioArgs.indexOf('-t') + 1], '12');
  assert.throws(() => parseArgs(['--job', 'jobs/demo.json', '--bad', 'x']), /Usage/);
});

test('missing FFmpeg fails with an actionable error and removes partial output', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'video-missing-encoder-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  await fs.writeFile(path.join(temporary, 'scene.mjs'), 'export function render(ctx) {ctx.fillRect(0,0,64,64);}');
  await fs.writeFile(path.join(temporary, 'job.json'), JSON.stringify({ id: 'missing', prompt: 'Test missing encoder.', code: 'scene.mjs', width: 64, height: 64, fps: 1, duration: 1 }));
  const previous = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = path.join(temporary, 'not-installed-ffmpeg');
  try {
    const out = path.join(temporary, 'out');
    await assert.rejects(renderJob('job.json', out, temporary), /Install FFmpeg or set FFMPEG_PATH/);
    assert.deepEqual(await fs.readdir(out), []);
  } finally {
    if (previous === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = previous;
  }
});

const ffmpegAvailable = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], { windowsHide: true }).status === 0;
test('renders actual 24 frame custom animation and checks video properties', { skip: !ffmpegAvailable && 'FFmpeg unavailable; set FFMPEG_PATH to run this integration test.' }, async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'video-render-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'repo');
  const out = path.join(temporary, 'out');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'scene.mjs'), 'export function render(ctx,{width,height,progress}) { ctx.fillStyle = "#132238";ctx.fillRect(0,0,width,height);ctx.fillStyle = "#ff816c";ctx.fillRect(progress * (width - 30),30,30,30); }');
  await fs.writeFile(path.join(root, 'job.json'), JSON.stringify({ id: 'integration', prompt: 'An animated coral square.', code: 'scene.mjs', width: 320, height: 180, fps: 24, duration: 1 }));
  const result = await renderJob('job.json', out, root);
  assert.equal(result.frames, 24);
  assert.ok(result.bytes > 500);
  assert.equal((await fs.readFile(result.poster)).subarray(1, 4).toString(), 'PNG');
  const inspection = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-i', result.mp4], { encoding: 'utf8', windowsHide: true });
  assert.match(inspection.stderr, /Video: h264/);
  assert.match(inspection.stderr, /yuv420p/);
  assert.match(inspection.stderr, /320x180/);
  assert.match(inspection.stderr, /24 fps/);
  const bytes = await fs.readFile(result.mp4);
  assert.ok(bytes.indexOf(Buffer.from('moov')) < bytes.indexOf(Buffer.from('mdat')), 'faststart places metadata before video data');
});

test('loops a short local WAV and encodes AAC for the full video duration', { skip: !ffmpegAvailable && 'FFmpeg unavailable.' }, async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'video-audio-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const samples = 1000;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(3000 * Math.sin(i / 8000 * Math.PI * 2 * 440)), 44 + i * 2);
  await fs.writeFile(path.join(temporary, 'tone.wav'), wav);
  await fs.writeFile(path.join(temporary, 'scene.mjs'), 'export async function prepare(info) {if (!info.assets.tone.endsWith("tone.wav")) throw new Error("asset missing");} export async function render(ctx,{width,height}) {ctx.fillStyle="#132238";ctx.fillRect(0,0,width,height);}');
  await fs.writeFile(path.join(temporary, 'job.json'), JSON.stringify({ id: 'audio', prompt: 'A scene with sound.', code: 'scene.mjs', audio: 'tone.wav', assets: { tone: 'tone.wav' }, width: 320, height: 180, fps: 12, duration: 1 }));
  const report = await renderJob('job.json', path.join(temporary, 'out'), temporary);
  assert.equal(report.audio, 'tone.wav');
  const inspection = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-i', report.mp4], { encoding: 'utf8', windowsHide: true });
  assert.match(inspection.stderr, /Audio: aac/);
  assert.match(inspection.stderr, /Duration: 00:00:01\.00/);
});
