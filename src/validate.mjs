import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULTS = Object.freeze({ width: 1280, height: 720, fps: 24, duration: 12, enabled: true });
export const LIMITS = Object.freeze({ maxDimension: 1920, maxPixels: 2073600, maxDuration: 120, maxFrames: 7200, maxAssets: 32, maxAssetBytes: 100 * 1024 * 1024 });
const MODULE_EXTENSIONS = new Set(['.mjs']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac']);
const ASSET_EXTENSIONS = new Set([...AUDIO_EXTENSIONS, '.png', '.jpg', '.jpeg', '.webp', '.ttf', '.otf']);
const MAX_JOB_BYTES = 64 * 1024;

export function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

export function validateJobData(data, { requireCode = true } = {}) {
  if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error('Job must be a JSON object.');
  const job = { ...DEFAULTS, ...data };
  if (typeof job.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(job.id)) throw new Error('id must be 1–64 lowercase letters, numbers, underscores or hyphens.');
  if (typeof job.prompt !== 'string' || job.prompt.length < 1 || job.prompt.length > 8000) throw new Error('prompt must be a nonempty string of at most 8,000 characters.');
  if (typeof job.enabled !== 'boolean') throw new Error('enabled must be true or false.');
  if (job.repeat !== undefined && job.repeat !== 'daily') throw new Error('repeat must be omitted or "daily".');
  for (const field of ['width', 'height']) {
    if (!Number.isInteger(job[field]) || job[field] < 64 || job[field] > LIMITS.maxDimension || job[field] % 2 !== 0) throw new Error(`${field} must be an even integer from 64 to ${LIMITS.maxDimension}.`);
  }
  if (job.width * job.height > LIMITS.maxPixels) throw new Error('Resolution must not exceed 2,073,600 pixels (1080p).');
  if (!Number.isInteger(job.fps) || job.fps < 1 || job.fps > 60) throw new Error('fps must be an integer from 1 to 60.');
  if (!Number.isFinite(job.duration) || job.duration < 0.1 || job.duration > LIMITS.maxDuration) throw new Error(`duration must be from 0.1 to ${LIMITS.maxDuration} seconds.`);
  if (Math.ceil(job.duration * job.fps) > LIMITS.maxFrames) throw new Error(`A job may contain at most ${LIMITS.maxFrames} frames.`);
  if ((requireCode || job.code !== undefined) && typeof job.code !== 'string') throw new Error('code must name a local .mjs scene file.');
  if (job.audio !== undefined && typeof job.audio !== 'string') throw new Error('audio must name a local audio file.');
  if (job.assets !== undefined && (!job.assets || typeof job.assets !== 'object' || Array.isArray(job.assets))) throw new Error('assets must be an object of names mapped to local asset paths.');
  if (Object.keys(job.assets ?? {}).length > LIMITS.maxAssets) throw new Error(`At most ${LIMITS.maxAssets} assets are supported.`);
  for (const [name, value] of Object.entries(job.assets ?? {})) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) throw new Error(`Invalid asset name: ${name}`);
    if (typeof value !== 'string') throw new Error(`Asset ${name} must name a local file.`);
  }
  return job;
}

// Check both the spelled path and its real target, so symlinks cannot escape
// the read-only repository. URLs, absolute paths and '..' are never accepted.
export async function resolveLocalFile(root, relative, extensions, label, maxBytes = LIMITS.maxAssetBytes) {
  if (typeof relative !== 'string' || !relative || relative.includes('\0') || path.isAbsolute(relative) || /^[a-zA-Z]:|^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(relative)) throw new Error(`${label} must be a repository-relative path.`);
  const pieces = relative.replaceAll('\\', '/').split('/');
  if (pieces.some(p => p === '..' || p === '') || relative.startsWith('\\')) throw new Error(`${label} may not contain traversal or empty path segments.`);
  const candidate = path.resolve(root, ...pieces);
  if (!isWithin(root, candidate)) throw new Error(`${label} must be beneath the repository root.`);
  if (!extensions.has(path.extname(candidate).toLowerCase())) throw new Error(`${label} has an unsupported file extension.`);
  const resolved = await fs.realpath(candidate);
  if (!isWithin(root, resolved)) throw new Error(`${label} resolves outside the repository root.`);
  const stat = await fs.stat(resolved);
  if (!stat.isFile() || stat.size > maxBytes) throw new Error(`${label} must be a file smaller than ${maxBytes} bytes.`);
  return resolved;
}

export function defaultRepoRoot() {
  return path.resolve(process.env.VIDEO_REPO_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
}

export async function loadJob(jobFile, repoRoot = defaultRepoRoot(), { requireCode = true } = {}) {
  const root = await fs.realpath(repoRoot);
  const supplied = path.isAbsolute(jobFile) ? path.relative(root, jobFile) : jobFile;
  const jobPath = await resolveLocalFile(root, supplied, new Set(['.json']), 'job', MAX_JOB_BYTES);
  const job = validateJobData(JSON.parse(await fs.readFile(jobPath, 'utf8')), { requireCode });
  const codePath = job.code === undefined ? undefined : await resolveLocalFile(root, job.code, MODULE_EXTENSIONS, 'code', 1024 * 1024);
  const audioPath = job.audio === undefined ? undefined : await resolveLocalFile(root, job.audio, AUDIO_EXTENSIONS, 'audio');
  const assetPaths = Object.create(null);
  for (const [name, relative] of Object.entries(job.assets ?? {})) assetPaths[name] = await resolveLocalFile(root, relative, ASSET_EXTENSIONS, `asset ${name}`);
  return { job, root, jobPath, codePath, audioPath, assetPaths: Object.freeze(assetPaths) };
}

// `node src/validate.mjs jobs/demo.json` validates data and files; it never
// imports or executes the custom scene. The workflow uses this before Docker.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const requested = process.argv.slice(2);
  if (!requested.length) { console.error('Usage: node src/validate.mjs <jobs/file.json> [...]'); process.exitCode = 1; }
  for (const jobFile of requested) {
    try {
      const { job } = await loadJob(jobFile, defaultRepoRoot(), { requireCode: false });
      console.log(JSON.stringify({ id: job.id, enabled: job.enabled, frames: Math.ceil(job.fps * job.duration), width: job.width, height: job.height }));
    } catch (error) { console.error(`${jobFile}: ${error.message}`); process.exitCode = 1; }
  }
}
