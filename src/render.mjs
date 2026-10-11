import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import { defaultRepoRoot, loadJob } from './validate.mjs';

const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

/* Scene module contract:
 *   export async function prepare({ width, height, fps, duration, prompt,
 *                                   assets, loadImage, GlobalFonts }) {}
 *   export function render(ctx, { t, time, width, height, progress, frame,
 *                                fps, duration, prompt, assets }) {}
 * `prepare` is optional and runs once. `render` runs once per frame and may
 * return a Promise. t/time are seconds; frame is zero-based; progress is 0–1.
 * Draw with the Canvas 2D API. Balance every ctx.save() with ctx.restore().
 * Asset names map to validated absolute local paths. Put images/fonts/audio
 * in assets/, declare them in the job, and preload images during prepare.
 * Custom modules are arbitrary JavaScript. Validation is not a sandbox;
 * execute generated modules only inside the workflow's restricted container.
 */

export function buildFfmpegArgs(job, outputFile, audioPath) {
  const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-y',
    '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', `${job.width}x${job.height}`,
    '-framerate', String(job.fps), '-i', 'pipe:0'];
  if (audioPath) args.push('-stream_loop', '-1', '-i', audioPath);
  args.push('-map', '0:v:0');
  if (audioPath) args.push('-map', '1:a:0', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
  else args.push('-an');
  args.push('-t', String(Math.ceil(job.duration * job.fps) / job.fps),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-maxrate', '8M', '-bufsize', '16M',
    '-threads', '2', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-f', 'mp4', outputFile);
  return args;
}

async function assertSafeDestination(filename) {
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Output path must be a regular file: ${filename}`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function renderJob(jobFile, outDir, repoRoot = defaultRepoRoot()) {
  const { job, codePath, audioPath, assetPaths } = await loadJob(jobFile, repoRoot);
  if (!job.enabled) throw new Error(`Job ${job.id} is disabled.`);
  await fs.mkdir(outDir, { recursive: true });
  const outputRoot = await fs.realpath(outDir);
  const mp4 = path.join(outputRoot, `${job.id}.mp4`);
  const poster = path.join(outputRoot, `${job.id}-poster.png`);
  const manifest = path.join(outputRoot, `${job.id}-manifest.json`);
  for (const destination of [mp4, poster, manifest]) await assertSafeDestination(destination);
  const partial = path.join(outputRoot, `${job.id}-${randomUUID()}.part.mp4`);
  const scene = await import(pathToFileURL(codePath).href);
  if (typeof scene.render !== 'function') throw new Error('Scene must export a named render(ctx, frameInfo) function.');
  if (scene.prepare !== undefined && typeof scene.prepare !== 'function') throw new Error('Scene prepare export must be a function.');
  const shared = Object.freeze({ width: job.width, height: job.height, fps: job.fps, duration: job.duration, prompt: job.prompt, assets: assetPaths });
  if (scene.prepare) await scene.prepare(Object.freeze({ ...shared, loadImage, GlobalFonts }));
  const canvas = createCanvas(job.width, job.height);
  const ctx = canvas.getContext('2d');
  const frameCount = Math.ceil(job.duration * job.fps);
  const posterFrame = Math.min(frameCount - 1, Math.floor(frameCount * 0.6));
  const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', buildFfmpegArgs(job, partial, audioPath), { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  let diagnostics = '';
  let pipeError;
  let launchError;
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-16000); });
  child.stdin.on('error', error => { pipeError = error; });
  const completed = new Promise(resolve => {
    child.once('error', error => { launchError = error; resolve({ error }); });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const stop = () => child.kill('SIGTERM');
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  let posterBytes;
  try {
    for (let frame = 0; frame < frameCount; frame++) {
      if (pipeError || child.exitCode !== null || child.signalCode !== null) throw new Error('FFmpeg stopped accepting frames.');
      ctx.resetTransform();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, job.width, job.height);
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, job.width, job.height);
      ctx.save();
      try {
        await scene.render(ctx, Object.freeze({ ...shared, t: frame / job.fps, time: frame / job.fps, frame, progress: frameCount <= 1 ? 1 : frame / (frameCount - 1) }));
      } finally { ctx.restore(); }
      if (frame === posterFrame) posterBytes = canvas.toBuffer('image/png');
      const pixels = ctx.getImageData(0, 0, job.width, job.height).data;
      if (!child.stdin.write(Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength))) {
        const drained = once(child.stdin, 'drain').then(() => true, () => false);
        const ready = await Promise.race([drained, completed.then(() => false)]);
        if (!ready) throw new Error('FFmpeg stopped accepting frames.');
      }
    }
    child.stdin.end();
    const result = await completed;
    if (result.error) throw result.error;
    if (result.code !== 0) throw new Error(`FFmpeg exited with ${result.signal || result.code}.`);
    const stat = await fs.stat(partial);
    if (stat.size === 0 || stat.size > MAX_OUTPUT_BYTES) throw new Error('MP4 output is empty or exceeds the 256 MiB limit.');
    await fs.rename(partial, mp4);
    await fs.writeFile(poster, posterBytes);
    const report = { id: job.id, prompt: job.prompt, code: job.code, width: job.width, height: job.height, fps: job.fps, requestedDuration: job.duration, duration: frameCount / job.fps, frames: frameCount, bytes: stat.size, audio: job.audio ?? null, files: { video: path.basename(mp4), poster: path.basename(poster) }, renderedAt: new Date().toISOString() };
    await fs.writeFile(manifest, `${JSON.stringify(report, null, 2)}\n`);
    return { ...report, mp4, poster, manifest };
  } catch (error) {
    stop();
    await completed;
    await fs.rm(partial, { force: true });
    const hint = error.code === 'ENOENT' || launchError?.code === 'ENOENT' ? 'Install FFmpeg or set FFMPEG_PATH to its executable.' : diagnostics.trim();
    throw new Error(`${error.message}${hint ? `\n${hint}` : ''}`, { cause: error });
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
}

export function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--job', '--out', '--root'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--') || options[key.slice(2)]) throw new Error('Usage: node src/render.mjs --job jobs/demo.json --out out [--root repo]');
    options[key.slice(2)] = args[i + 1];
  }
  if (!options.job || !options.out) throw new Error('Both --job and --out are required.');
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = await renderJob(options.job, options.out, options.root);
    console.log(JSON.stringify(report));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
