import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultRepoRoot, loadJob, isWithin } from './validate.mjs';
import { generateCode } from './generate.mjs';

const MAX_JOBS = 3;
const MAX_JOB_RUNTIME_MS = 7 * 60 * 1000;
const MAX_STAGED_BYTES = 256 * 1024 * 1024;
const MAX_JOB_OUTPUT_BYTES = 60 * 1024 * 1024;
const ENGINE_FILES = ['Dockerfile', 'package.json', 'package-lock.json', 'src/render.mjs', 'src/validate.mjs', 'src/generate.mjs', 'src/queue.mjs'];

export function indiaDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function relativeAsset(relative) {
  const pieces = relative.replaceAll('\\', '/').split('/');
  if (pieces.some(part => ['.git', 'node_modules', '.state'].includes(part.toLowerCase()))) throw new Error('Scene code and assets cannot be in .git, node_modules, or .state.');
  return pieces.join('/');
}

function declaredFiles(loaded) {
  const entries = [];
  if (loaded.codePath) entries.push([relativeAsset(loaded.job.code), loaded.codePath]);
  if (loaded.audioPath) entries.push([relativeAsset(loaded.job.audio), loaded.audioPath]);
  for (const [name, source] of Object.entries(loaded.assetPaths)) entries.push([relativeAsset(loaded.job.assets[name]), source]);
  return [...new Map(entries).entries()];
}

export async function fingerprintJob(loaded, { now = new Date() } = {}) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify({ version: 1, job: loaded.job, day: loaded.job.repeat === 'daily' ? indiaDate(now) : null }));
  for (const [relative, source] of declaredFiles(loaded).sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(relative);
    hash.update(await fs.readFile(source));
  }
  for (const relative of ENGINE_FILES) {
    hash.update(relative);
    try { hash.update(await fs.readFile(path.join(loaded.root, relative))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return hash.digest('hex');
}

async function readState(stateFile) {
  try {
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    if (state.version === 1 && state.rendered && typeof state.rendered === 'object' && !Array.isArray(state.rendered)) return state;
  } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  return { version: 1, rendered: {} };
}

async function saveState(stateFile, state) {
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
  await fs.rename(temporary, stateFile);
}

async function manualJob(root, prompt) {
  if (!prompt) return undefined;
  if (prompt.length > 8000) throw new Error('Manual prompt must be at most 8,000 characters.');
  const id = `manual-${createHash('sha256').update(prompt).digest('hex').slice(0, 12)}`;
  const relative = '.state/manual/job.json';
  await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await fs.writeFile(path.join(root, relative), JSON.stringify({ id, prompt, width: 1280, height: 720, fps: 24, duration: 12, enabled: true }));
  return relative;
}

export async function inspectQueue({ root = defaultRepoRoot(), jobId = '', prompt = '', force = false, now = new Date() } = {}) {
  root = await fs.realpath(root);
  if (jobId && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(jobId)) throw new Error('Select a job by its id, using lowercase letters, numbers, hyphens or underscores.');
  if (prompt && jobId) throw new Error('Use either a manual prompt or an existing job id.');
  const stateFile = path.join(root, '.state/rendered.json');
  const state = await readState(stateFile);
  const oneOff = await manualJob(root, prompt);
  let files;
  if (oneOff) files = [oneOff];
  else {
    let names = [];
    try { names = await fs.readdir(path.join(root, 'jobs')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    files = names.filter(name => name.endsWith('.json')).sort().map(name => `jobs/${name}`);
  }
  const items = [];
  const ids = new Set();
  for (const file of files) {
    try {
      const loaded = await loadJob(file, root, { requireCode: false });
      if (ids.has(loaded.job.id)) throw new Error(`Duplicate job id: ${loaded.job.id}`);
      ids.add(loaded.job.id);
      if (jobId && loaded.job.id !== jobId) continue;
      if (!loaded.job.enabled) { items.push({ file, id: loaded.job.id, status: 'disabled' }); continue; }
      const fingerprint = await fingerprintJob(loaded, { now });
      const unchanged = !force && state.rendered[loaded.job.id]?.fingerprint === fingerprint;
      items.push({ file, id: loaded.job.id, status: unchanged ? 'unchanged' : 'pending', fingerprint, loaded });
    } catch (error) {
      items.push({ file, status: 'invalid', error: error.message });
    }
  }
  if (jobId && !ids.has(jobId)) items.push({ id: jobId, status: 'invalid', error: `No job has id ${jobId}.` });
  let selected = 0;
  for (const item of items) if (item.status === 'pending' && ++selected > MAX_JOBS) item.status = 'deferred';
  return { root, stateFile, state, items, now };
}

function command(command, args, { timeoutMs, prefix = '', env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    let settled = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('Render exceeded its seven-minute time limit.')); }, timeoutMs ?? MAX_JOB_RUNTIME_MS);
    const collect = data => {
      const text = String(data).replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
      tail = (tail + text).slice(-4000);
      // Prefixing lines prevents scene output from becoming Actions commands.
      if (prefix) for (const line of text.split(/\r?\n/)) if (line) console.log(`${prefix} ${line}`);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    }
    child.once('error', finish);
    child.once('close', (code, signal) => finish(code === 0 ? undefined : new Error(`${command} failed (${signal || code}). ${tail}`)));
  });
}

export function dockerArguments({ staging, output, image, containerName }) {
  return [
    'run', '--rm', '--name', containerName,
    '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--pids-limit', '128',
    '--memory', '2g', '--cpus', '2', '--user', '1000:1000',
    '--ulimit', 'fsize=209715200:209715200',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777',
    '--mount', `type=bind,src=${staging},dst=/workspace,readonly`,
    '--mount', `type=bind,src=${output},dst=/output`,
    image, '--job', 'jobs/job.json', '--out', '/output'
  ];
}

async function stageJob(loaded, staging) {
  let totalBytes = 0;
  for (const [relative, source] of declaredFiles(loaded)) {
    totalBytes += (await fs.stat(source)).size;
    if (totalBytes > MAX_STAGED_BYTES) throw new Error('Combined scene and assets must be at most 256 MB.');
    const destination = path.resolve(staging, relative);
    if (!isWithin(staging, destination)) throw new Error('Staged asset is outside the scene workspace.');
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
    await fs.copyFile(source, destination);
    await fs.chmod(destination, 0o644);
  }
}

function safeError(error, apiKey) {
  let text = String(error?.message || error).replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').slice(-4000);
  if (apiKey) text = text.replaceAll(apiKey, '[redacted]');
  return text;
}

async function prepareOutput(output, job, generated, code, { success = false } = {}) {
  const allowed = new Set(success ? [`${job.id}.mp4`, `${job.id}-poster.png`, `${job.id}-manifest.json`] : []);
  let totalBytes = generated ? Buffer.byteLength(code || '') : 0;
  for (const name of await fs.readdir(output)) {
    const file = path.join(output, name);
    const stat = await fs.lstat(file);
    if (!allowed.has(name) || !stat.isFile() || stat.isSymbolicLink()) {
      // rm does not follow symlinks. output is our dedicated per-job directory.
      await fs.rm(file, { recursive: true, force: true });
      continue;
    }
    totalBytes += stat.size;
  }
  if (generated && code) await fs.writeFile(path.join(output, `${job.id}-scene.mjs`), code);
  if (totalBytes > MAX_JOB_OUTPUT_BYTES) throw new Error('Video, poster and source exceed the 60 MB artifact limit per job.');
  if (success) for (const name of allowed) {
    const stat = await fs.lstat(path.join(output, name));
    if (!stat.isFile() || stat.isSymbolicLink() || !stat.size) throw new Error(`Renderer did not create a regular nonempty ${name}.`);
  }
}

export async function runQueue(options = {}) {
  const plan = await inspectQueue(options);
  const outputRoot = path.join(plan.root, 'out');
  await fs.mkdir(outputRoot, { recursive: true });
  const results = [];
  let changed = false;
  const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
  const generate = options.generate ?? generateCode;
  for (const item of plan.items) {
    if (item.status !== 'pending') { results.push({ id: item.id, file: item.file, status: item.status, error: item.error }); continue; }
    const { loaded } = item;
    const job = { ...loaded.job };
    const generated = !loaded.codePath;
    const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'video-scene-'));
    await fs.chmod(staging, 0o755);
    const output = path.join(outputRoot, job.id);
    const containerName = `video-${job.id}-${process.pid}`;
    let code;
    let attempts = 0;
    const deadline = Date.now() + MAX_JOB_RUNTIME_MS;
    async function generateWithinBudget(request) {
      const remainingMs = deadline - Date.now() - 50000;
      if (remainingMs <= 0) throw new Error('Job exceeded its seven-minute generation and render budget.');
      // At most three API attempts plus capped delays; reserve render time.
      return generate(request, { apiKey, timeoutMs: Math.max(1, Math.min(90000, Math.floor(remainingMs / 3))) });
    }
    try {
      await fs.mkdir(output, { recursive: true, mode: 0o777 });
      if (!isWithin(outputRoot, await fs.realpath(output))) throw new Error('Output directory resolves outside the output root.');
      await fs.chmod(output, 0o777);
      await stageJob(loaded, staging);
      if (generated) {
        if (options.localTrusted && !options.render) throw new Error('--local-trusted may only run authored code; AI code requires Docker.');
        code = await generateWithinBudget({ ...job, renderDate: job.repeat === 'daily' ? indiaDate(plan.now) : undefined });
        job.code = 'generated/scene.mjs';
      }
      async function writeAndRender() {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) throw new Error('Job exceeded its seven-minute generation and render budget.');
        if (generated) {
          const scene = path.join(staging, job.code);
          await fs.mkdir(path.dirname(scene), { recursive: true, mode: 0o755 });
          await fs.writeFile(scene, code, { mode: 0o644 });
          // --check parses syntax without importing or executing the AI code.
          const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
          await command(process.execPath, ['--check', scene], { timeoutMs: 10000, env });
        }
        await fs.mkdir(path.join(staging, 'jobs'), { recursive: true, mode: 0o755 });
        await fs.writeFile(path.join(staging, 'jobs/job.json'), JSON.stringify(job), { mode: 0o644 });
        attempts++;
        if (options.render) await options.render({ job, staging, output, attempts });
        else if (options.localTrusted) {
          console.warn(`[${job.id}] Running authored code locally with --local-trusted.`);
          if (generated) throw new Error('--local-trusted may only run authored code; AI code requires Docker.');
          await command(process.execPath, [path.join(plan.root, 'src/render.mjs'), '--root', staging, '--job', 'jobs/job.json', '--out', output], { prefix: `[${job.id}]`, timeoutMs: deadline - Date.now() });
        } else {
          try { await command('docker', dockerArguments({ staging, output, image: options.image || 'overnight-video:local', containerName }), { prefix: `[${job.id}]`, timeoutMs: deadline - Date.now() }); }
          catch (error) {
            // Kill any container still alive after a host subprocess timeout.
            await command('docker', ['rm', '--force', containerName], { timeoutMs: 10000 }).catch(() => {});
            throw error;
          }
        }
      }
      try { await writeAndRender(); }
      catch (error) {
        if (!generated) throw error;
        console.log(`[${job.id}] Repairing generated scene once after render failure.`);
        code = await generateWithinBudget({ ...loaded.job, renderDate: job.repeat === 'daily' ? indiaDate(plan.now) : undefined, previousCode: code, repairError: safeError(error, apiKey).slice(-2000) });
        await writeAndRender();
      }
      await prepareOutput(output, job, generated, code, { success: true });
      const video = path.join(output, `${job.id}.mp4`);
      if (!(await fs.stat(video)).isFile() || (await fs.stat(video)).size === 0) throw new Error('Renderer did not create a nonempty MP4.');
      plan.state.rendered[job.id] = { fingerprint: item.fingerprint, completedAt: new Date().toISOString() };
      // Keep only small completion markers. MP4s never enter the cache.
      const entries = Object.entries(plan.state.rendered).sort(([, a], [, b]) => String(b.completedAt).localeCompare(String(a.completedAt))).slice(0, 1000);
      plan.state.rendered = Object.fromEntries(entries);
      await saveState(plan.stateFile, plan.state);
      changed = true;
      results.push({ id: job.id, status: 'completed', generated, attempts, file: path.relative(plan.root, video).replaceAll('\\', '/') });
      console.log(`[${job.id}] Completed ${video}`);
    } catch (error) {
      await prepareOutput(output, job, generated, code).catch(() => {});
      const message = safeError(error, apiKey);
      results.push({ id: job.id, status: 'failed', error: message, attempts });
      console.error(`[${job.id}] ${message.replaceAll('\n', '\n[render error] ')}`);
    } finally {
      // staging is an OS-created dedicated directory, never a caller path.
      await fs.rm(staging, { recursive: true, force: true });
    }
  }
  const report = { createdAt: new Date().toISOString(), maxJobsPerRun: MAX_JOBS, results };
  await fs.writeFile(path.join(outputRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return { report, stateChanged: changed, failed: results.some(result => ['failed', 'invalid'].includes(result.status)) };
}

async function writeGithubOutputs(values) {
  if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const allowed = new Set(['--plan', '--force', '--local-trusted']);
    for (const arg of args) if (!allowed.has(arg)) throw new Error(`Unknown argument: ${arg}. Job selection uses INPUT_JOB, INPUT_PROMPT, INPUT_FORCE environment variables.`);
    const options = { jobId: process.env.INPUT_JOB || '', prompt: process.env.INPUT_PROMPT || '', force: args.includes('--force') || process.env.INPUT_FORCE === 'true', localTrusted: args.includes('--local-trusted') };
    if (args.includes('--plan')) {
      const plan = await inspectQueue(options);
      const pending = plan.items.filter(item => item.status === 'pending').length;
      const invalid = plan.items.filter(item => item.status === 'invalid').length;
      await writeGithubOutputs({ pending, work_required: pending + invalid > 0 });
      console.log(JSON.stringify({ pending, invalid, jobs: plan.items.map(({ id, status, error }) => ({ id, status, error })) }, null, 2));
    } else {
      const { report, stateChanged, failed } = await runQueue(options);
      await writeGithubOutputs({ state_changed: stateChanged });
      if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `Video queue: ${report.results.map(({ id, status }) => `${id || 'invalid job'}: ${status}`).join(', ') || 'no jobs'}.\n\nDownload MP4s from this run's **Artifacts** within one day.\n`);
      if (failed) process.exitCode = 1;
    }
  } catch (error) { console.error(safeError(error, process.env.GEMINI_API_KEY)); process.exitCode = 1; }
}
