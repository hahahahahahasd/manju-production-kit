#!/usr/bin/env node
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const managerDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(managerDir, '..', '..', '..', '..');
const managerPath = resolve(managerDir, 'comfy-batch-manager.mjs');
const runsDir = resolve(managerDir, 'runs');
const configPath = resolve(managerDir, 'supervisor-config.json');
const statusPath = resolve(managerDir, 'supervisor-status.json');
const eventsPath = resolve(managerDir, 'supervisor-events.jsonl');
const claimsDir = resolve(managerDir, 'supervisor-claims');
const lockPath = resolve(managerDir, 'supervisor.lock');
const [command = 'status', ...args] = process.argv.slice(2);
const confirmed = args.includes('--confirm-gpu');
const minimumStartJobs = 1;

function now() { return new Date().toISOString(); }
function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}
function appendEvent(event, detail = null) {
  mkdirSync(dirname(eventsPath), { recursive: true });
  appendFileSync(eventsPath, `${JSON.stringify({ at: now(), event, detail })}\n`);
}
function insideProject(path) { return path === projectRoot || path.startsWith(`${projectRoot}/`); }
function resolveBatch(candidate) {
  const path = isAbsolute(candidate) ? resolve(candidate) : resolve(managerDir, candidate);
  if (!insideProject(path)) throw new Error(`批次路径必须位于项目内：${candidate}`);
  return path;
}
function loadConfig() {
  const config = readJson(configPath);
  if (config.schema !== 'manju.comfyui-supervisor/v1') throw new Error('supervisor-config.json schema 无效');
  if (!Array.isArray(config.batchPaths)) throw new Error('supervisor-config.json 缺少 batchPaths');
  return {
    enabled: config.enabled === true,
    targetTrackedJobs: Math.max(minimumStartJobs, Number(config.targetTrackedJobs || 2)),
    idleAlertSeconds: Math.max(30, Number(config.idleAlertSeconds || 120)),
    intervalSeconds: Math.max(2, Number(config.intervalSeconds || 5)),
    batchPaths: config.batchPaths.map(resolveBatch)
  };
}
function loadRun(batchId) {
  const path = resolve(runsDir, `${batchId}.json`);
  return existsSync(path) ? readJson(path) : null;
}
function inspect(config) {
  const batches = config.batchPaths.map((path) => {
    if (!existsSync(path)) return { path, id: null, state: 'missing', run: null };
    const batch = readJson(path);
    const run = loadRun(batch.id);
    return { path, id: batch.id, state: run?.status ?? 'not_started', run };
  });
  const jobs = batches.flatMap((batch) => batch.run?.jobs ?? []);
  const trackedJobs = jobs.filter((job) => ['submitted', 'collecting'].includes(job.state)).length;
  const unknownJobs = jobs.filter((job) => ['unknown', 'skipped_after_unknown'].includes(job.state));
  const readyBatches = batches.filter((batch) => batch.id && !batch.run && !existsSync(resolve(claimsDir, `${batch.id}.json`)));
  const claimedBatches = batches.filter((batch) => batch.id && !batch.run && existsSync(resolve(claimsDir, `${batch.id}.json`)));
  const completedJobs = jobs.filter((job) => job.state === 'needs_visual_qc').length;
  const reviewedJobs = jobs.filter((job) => job.visualReview).length;
  return { batches, trackedJobs, unknownJobs, readyBatches, claimedBatches, completedJobs, reviewedJobs };
}
function validateBatch(path) {
  const result = spawnSync(process.execPath, [managerPath, 'validate', '--batch', path], { cwd: managerDir, encoding: 'utf8' });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || '批次校验失败').trim());
  return JSON.parse(result.stdout);
}
function claimBatch(batch) {
  mkdirSync(claimsDir, { recursive: true });
  const path = resolve(claimsDir, `${batch.id}.json`);
  const handle = openSync(path, 'wx');
  writeFileSync(handle, `${JSON.stringify({ batchId: batch.id, batchPath: batch.path, claimedAt: now(), supervisorPid: process.pid }, null, 2)}\n`);
  closeSync(handle);
  return path;
}
function submitBatch(batch) {
  validateBatch(batch.path);
  claimBatch(batch);
  const stdout = openSync(resolve(managerDir, 'manager.out'), 'a');
  const stderr = openSync(resolve(managerDir, 'manager.err'), 'a');
  const child = spawn(process.execPath, [managerPath, 'start', '--batch', batch.path, '--confirm-gpu'], {
    cwd: managerDir,
    detached: true,
    stdio: ['ignore', stdout, stderr]
  });
  child.unref();
  closeSync(stdout);
  closeSync(stderr);
  appendEvent('batch_submission_started', { batchId: batch.id, batchPath: relative(projectRoot, batch.path), pid: child.pid });
  return child.pid;
}
function latestProgressAt(snapshot) {
  const values = snapshot.batches.flatMap((batch) => {
    if (!batch.run) return [];
    return [batch.run.updatedAt, ...batch.run.jobs.flatMap((job) => [job.runtime?.lastEventAt, job.runtime?.progress?.updatedAt])].filter(Boolean);
  });
  return values.sort().at(-1) ?? null;
}
function buildStatus(config, snapshot, previous, action = null, error = null) {
  const updatedAt = now();
  const idle = snapshot.trackedJobs === 0;
  const idleSince = idle ? (previous?.idleSince ?? updatedAt) : null;
  const idleSeconds = idleSince ? Math.max(0, Math.floor((Date.now() - Date.parse(idleSince)) / 1000)) : 0;
  let state = snapshot.trackedJobs > 0 ? 'working' : 'idle_no_reviewed_reserve';
  if (!config.enabled) state = 'disabled';
  if (snapshot.unknownJobs.length) state = 'blocked_unknown_submission';
  else if (snapshot.claimedBatches.length && snapshot.trackedJobs === 0) state = 'waiting_for_submission_start';
  else if (action?.type === 'submitted') state = 'submitted_next_batch';
  const alerts = [];
  if (snapshot.unknownJobs.length) alerts.push(`存在 ${snapshot.unknownJobs.length} 条 unknown/skipped_after_unknown，禁止自动重试`);
  if (idleSeconds >= config.idleAlertSeconds && snapshot.readyBatches.length === 0 && snapshot.claimedBatches.length === 0) alerts.push(`GPU 调度已空闲 ${idleSeconds} 秒且没有已核查储备批次`);
  if (error) alerts.push(error);
  return {
    schema: 'manju.comfyui-supervisor-status/v1',
    updatedAt,
    state,
    supervisorPid: process.pid,
    gpuSubmissionConfirmed: confirmed,
    trackedJobs: snapshot.trackedJobs,
    minimumStartJobs,
    targetTrackedJobs: config.targetTrackedJobs,
    rollingRefill: true,
    readyBatchCount: snapshot.readyBatches.length,
    claimedBatchCount: snapshot.claimedBatches.length,
    completedJobs: snapshot.completedJobs,
    reviewedJobs: snapshot.reviewedJobs,
    idleSince,
    idleSeconds,
    lastProgressAt: latestProgressAt(snapshot),
    action,
    alerts,
    batches: snapshot.batches.map((batch) => ({
      id: batch.id,
      path: relative(projectRoot, batch.path),
      status: batch.run?.status ?? batch.state,
      jobs: batch.run?.jobs?.map((job) => ({ id: job.id, state: job.state, promptId: job.promptId, runtime: job.runtime ?? null, visualReview: job.visualReview ?? null })) ?? []
    }))
  };
}
function tick() {
  const config = loadConfig();
  const previous = existsSync(statusPath) ? readJson(statusPath) : null;
  let snapshot = inspect(config);
  let action = null;
  let error = null;
  if (config.enabled && confirmed && snapshot.unknownJobs.length === 0 && snapshot.trackedJobs < config.targetTrackedJobs && snapshot.readyBatches.length) {
    const next = snapshot.readyBatches[0];
    try {
      const validation = validateBatch(next.path);
      if ((validation.jobs?.length ?? 0) < minimumStartJobs) throw new Error(`生产批次少于 ${minimumStartJobs} 条任务`);
      const pid = submitBatch(next);
      action = { type: 'submitted', batchId: next.id, pid };
      snapshot = inspect(config);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      appendEvent('submission_blocked', { batchId: next.id, error });
    }
  }
  const status = buildStatus(config, snapshot, previous, action, error);
  if (previous?.state !== status.state) appendEvent('state_changed', { from: previous?.state ?? null, to: status.state, alerts: status.alerts });
  writeJson(statusPath, status);
  return status;
}
function acquireLock() {
  if (existsSync(lockPath)) {
    const existing = readJson(lockPath);
    try { process.kill(existing.pid, 0); throw new Error(`Supervisor 已运行，PID ${existing.pid}`); }
    catch (error) {
      if (error?.code !== 'ESRCH') throw error;
      renameSync(lockPath, `${lockPath}.stale-${Date.now()}`);
    }
  }
  writeJson(lockPath, { pid: process.pid, startedAt: now() });
}
function releaseLock() {
  if (!existsSync(lockPath)) return;
  const lock = readJson(lockPath);
  if (lock.pid === process.pid) unlinkSync(lockPath);
}
function run() {
  acquireLock();
  let ticking = false;
  let rerun = false;
  const executeTick = () => {
    if (ticking) { rerun = true; return; }
    ticking = true;
    try { tick(); }
    catch (error) {
      const previous = existsSync(statusPath) ? readJson(statusPath) : null;
      writeJson(statusPath, { ...(previous ?? {}), updatedAt: now(), state: 'supervisor_error', supervisorPid: process.pid, alerts: [error instanceof Error ? error.message : String(error)] });
      appendEvent('supervisor_error', error instanceof Error ? error.message : String(error));
    } finally {
      ticking = false;
      if (rerun) { rerun = false; setTimeout(executeTick, 0); }
    }
  };
  const config = loadConfig();
  mkdirSync(runsDir, { recursive: true });
  const watchers = [watch(runsDir, executeTick), watch(dirname(configPath), (event, filename) => {
    if (filename === 'supervisor-config.json' || filename === 'events.jsonl') executeTick();
  })];
  const timer = setInterval(executeTick, config.intervalSeconds * 1000);
  const stop = () => { clearInterval(timer); watchers.forEach((entry) => entry.close()); releaseLock(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  executeTick();
}

if (!['run', 'once', 'status'].includes(command)) throw new Error('用法：node supervisor.mjs run|once|status [--confirm-gpu]');
if (command === 'status') process.stdout.write(`${JSON.stringify(existsSync(statusPath) ? readJson(statusPath) : { state: 'not_started' }, null, 2)}\n`);
if (command === 'once') process.stdout.write(`${JSON.stringify(tick(), null, 2)}\n`);
if (command === 'run') run();
