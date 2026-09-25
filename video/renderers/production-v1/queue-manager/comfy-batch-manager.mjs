#!/usr/bin/env node
/**
 * Durable, event-driven batch manager for reviewed ComfyUI jobs.
 *
 * It submits at most three explicit plan/segment pairs once, listens to the
 * exact ComfyUI WebSocket client channel, then collects completed media and
 * writes a technical review package. It never retries or approves visuals.
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const [command, ...args] = process.argv.slice(2);
const managerDir = dirname(fileURLToPath(import.meta.url));
const productionDir = dirname(managerDir);
const projectRoot = resolve(managerDir, '..', '..', '..', '..');
const rendererPath = resolve(productionDir, '..', 'comfyui-wan-i2v.mjs');
const directorValidatorPath = resolve(projectRoot, '.agents/skills/manju-production/scripts/validate-sequence.mjs');
const runsDir = resolve(managerDir, 'runs');
const eventsPath = resolve(managerDir, 'events.jsonl');
const maxJobs = 3;
const minimumStartJobs = 1;
const targetTrackedJobs = 2;

function fail(message) { console.error(message); process.exit(1); }
function now() { return new Date().toISOString(); }
function flag(name) { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; }
function hasFlag(name) { return args.includes(name); }
function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporaryPath, path);
}
function resolveFrom(basePath, candidate) { return isAbsolute(candidate) ? candidate : resolve(dirname(basePath), candidate); }
function relativeFrom(basePath, targetPath) { return relative(dirname(basePath), targetPath) || '.'; }
function sha256File(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function appendEvent(event, data = {}) {
  mkdirSync(dirname(eventsPath), { recursive: true });
  const row = { at: now(), event, batchId: data.batchId ?? null, jobId: data.jobId ?? null, promptId: data.promptId ?? null, detail: data.detail ?? null };
  appendFileSync(eventsPath, `${JSON.stringify(row)}\n`);
  process.stdout.write(`${row.at}\t${event}\t${row.batchId ?? '-'}\t${row.jobId ?? '-'}\t${row.promptId ?? '-'}\n`);
}
function usage() {
  fail(`用法：
  node comfy-batch-manager.mjs validate --batch <批次.json>
  node comfy-batch-manager.mjs start --batch <批次.json>
  node comfy-batch-manager.mjs status --batch <批次.json>
  node comfy-batch-manager.mjs health --batch <批次.json>

生产批次允许 1-3 条已核验任务；1 条可立即启动，守护进程随后滚动补到 2-3 条。start 只提交一次，完成后自动收片和技术质检。`);
}
function batchPath() { const value = flag('--batch'); if (!value) usage(); return resolve(value); }
function loadBatch(path) {
  const batch = readJson(path);
  if (batch.schema !== 'manju.comfyui-event-batch/v1') fail('不是 ComfyUI 事件批次');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(batch.id || '')) fail('批次 id 只能使用字母、数字、点、下划线和连字符');
  if (!Array.isArray(batch.jobs) || batch.jobs.length < 1 || batch.jobs.length > maxJobs) fail(`批次必须有 1-${maxJobs} 条任务`);
  const ids = new Set();
  for (const job of batch.jobs) {
    if (!job.id || !job.plan || !job.segment) fail('每条任务需要 id、plan、segment');
    if (ids.has(job.id)) fail(`批次任务 id 重复：${job.id}`);
    ids.add(job.id);
  }
  return batch;
}
function assertProductionAdmission(batch) {
  if (batch.testOnly) return;
  if (batch.jobs.length < minimumStartJobs) fail(`生产批次至少需要 ${minimumStartJobs} 条任务`);
  if (!batch.admission?.reviewedAt) fail('生产批次缺少 admission.reviewedAt；禁止提交未核查任务');
  for (const job of batch.jobs) {
    if (job.gpuReviewed !== true || typeof job.reviewNotes !== 'string' || !job.reviewNotes.trim()) fail(`${job.id} 缺少 gpuReviewed=true 或 reviewNotes；禁止用未核查镜头填队`);
    if (!job.productionShot || !job.shotId) fail(`${job.id} 缺少 productionShot 或 shotId；生产任务必须通过导演镜头卡准入`);
    const quality = job.qualityGate;
    if (!quality || quality.nativeDetailReviewed !== true) fail(`${job.id} 缺少 qualityGate.nativeDetailReviewed=true；禁止提交未做原生细节审查的任务`);
    if (!Number.isFinite(quality.sourceCropUpscaleRatio) || quality.sourceCropUpscaleRatio <= 0) fail(`${job.id} 缺少有效 sourceCropUpscaleRatio`);
    const maximum = Number.isFinite(quality.maxAllowedUpscaleRatio) ? quality.maxAllowedUpscaleRatio : 1.25;
    if (quality.sourceCropUpscaleRatio > maximum) fail(`${job.id} 裁切放大比 ${quality.sourceCropUpscaleRatio} 超过硬上限 ${maximum}`);
    if (quality.visibleIdentity === true && quality.identityReferenceReviewed !== true) fail(`${job.id} 有可见人物但未完成角色表对照`);
  }
}
function runPath(batchId) { return resolve(runsDir, `${batchId}.json`); }
function loadRun(batchId) { const path = runPath(batchId); return existsSync(path) ? readJson(path) : null; }
function saveRun(run) { run.updatedAt = now(); writeJson(runPath(run.id), run); }
function shell(command, parameters, options = {}) {
  const result = spawnSync(command, parameters, { encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${command} failed: ${(result.stderr || result.stdout || '').trim()}`);
  return result.stdout;
}
function getPlanJob(batchFile, batchJob) {
  const planPath = resolveFrom(batchFile, batchJob.plan);
  if (!existsSync(planPath)) fail(`缺少计划：${planPath}`);
  const plan = readJson(planPath);
  const segment = plan.segments?.find((entry) => entry.id === batchJob.segment);
  if (!segment) fail(`${batchJob.id} 在计划中找不到段落 ${batchJob.segment}`);
  const imagePath = resolveFrom(planPath, segment.sourceImage || '');
  if (!existsSync(imagePath)) fail(`${batchJob.id} 缺少源图：${imagePath}`);
  if (segment.sourceImageSha256 && sha256File(imagePath) !== segment.sourceImageSha256) fail(`${batchJob.id} 源图 SHA256 不匹配`);
  if (segment.status !== 'not_submitted') fail(`${batchJob.id} 当前计划状态为 ${segment.status}，拒绝重复提交`);
  return { planPath, plan, segment, imagePath };
}
function validate(batchFile, batch) {
  assertProductionAdmission(batch);
  const seenPairs = new Set();
  const report = [];
  for (const job of batch.jobs) {
    if (!batch.testOnly) {
      const productionShotPath = resolveFrom(batchFile, job.productionShot);
      if (!existsSync(productionShotPath)) fail(`${job.id} 缺少导演镜头表：${productionShotPath}`);
      shell(process.execPath, [directorValidatorPath, '--shots', productionShotPath, '--shot-id', job.shotId, '--require-generation-ready']);
    }
    const inspected = getPlanJob(batchFile, job);
    const key = `${inspected.planPath}:${job.segment}`;
    if (seenPairs.has(key)) fail(`同一计划段落重复：${job.id}`);
    seenPairs.add(key);
    shell(process.execPath, [rendererPath, 'validate', inspected.planPath]);
    report.push({ id: job.id, plan: relativeFrom(batchFile, inspected.planPath), segment: job.segment, productionShot: job.productionShot ?? null, shotId: job.shotId ?? null, directorGate: batch.testOnly ? 'test_only' : 'generation_ready', sourceImageSha256: sha256File(inspected.imagePath), durationSeconds: inspected.segment.durationSeconds, gpuReviewed: job.gpuReviewed === true, reviewNotes: job.reviewNotes ?? null });
  }
  return report;
}
function newRun(batchFile, batch, validation) {
  return {
    schema: 'manju.comfyui-event-batch-run/v1',
    id: batch.id,
    batchPath: batchFile,
    clientId: `manju-batch-${batch.id}-${randomUUID()}`,
    status: 'preflight_passed',
    createdAt: now(),
    updatedAt: now(),
    queuePolicy: { minimumStartJobs, targetTrackedJobs, maxJobs, rollingRefill: true, admissionRequired: !batch.testOnly },
    queueHealth: { state: 'preflight_passed', trackedJobs: 0, minimumStartJobs, targetTrackedJobs, updatedAt: now() },
    jobs: validation.map((item) => ({ ...item, state: 'preflight_passed', promptId: null, output: null, technicalQc: null, visualReview: null, runtime: null, error: null }))
  };
}
function findRunJob(run, promptId) { return run.jobs.find((job) => job.promptId === promptId); }
function trackedJobs(run) { return run.jobs.filter((job) => ['submitted', 'collecting'].includes(job.state)).length; }
function refreshQueueHealth(run) {
  const tracked = trackedJobs(run);
  const terminal = allTerminal(run);
  const state = terminal ? 'refill_required' : tracked >= targetTrackedJobs ? 'capacity_met' : 'rolling_refill';
  const lastSignalledState = run.queueHealth?.lastSignalledState ?? null;
  run.queueHealth = { state, trackedJobs: tracked, minimumStartJobs, targetTrackedJobs, updatedAt: now(), lastSignalledState };
  if (lastSignalledState === state) return;
  if (state === 'rolling_refill') appendEvent('queue_rolling_refill', { batchId: run.id, detail: `已有 ${tracked}/${targetTrackedJobs} 条运行；发现新的已核查任务即可滚动补入，禁止用未核查任务填队` });
  if (state === 'refill_required') appendEvent('queue_refill_required', { batchId: run.id, detail: `本批已结束；下一条已核查任务可立即启动，并继续补到 ${targetTrackedJobs}-${maxJobs} 条` });
  run.queueHealth.lastSignalledState = state;
}
function refreshPromptId(run, runJob) {
  const planPath = resolveFrom(run.batchPath, runJob.plan);
  const plan = readJson(planPath);
  const segment = plan.segments.find((entry) => entry.id === runJob.segment);
  runJob.promptId = segment?.submission?.promptId || null;
  if (!runJob.promptId) fail(`${runJob.id} 提交未留下 promptId`);
}
function submitAll(run) {
  run.status = 'submitting';
  saveRun(run);
  for (let index = 0; index < run.jobs.length; index += 1) {
    const job = run.jobs[index];
    const planPath = resolveFrom(run.batchPath, job.plan);
    try {
      shell(process.execPath, [rendererPath, 'submit', planPath, '--segment', job.segment, '--confirm-gpu', '--client-id', run.clientId]);
      refreshPromptId(run, job);
      job.state = 'submitted';
      appendEvent('submitted', { batchId: run.id, jobId: job.id, promptId: job.promptId });
      saveRun(run);
    } catch (error) {
      job.state = 'unknown';
      job.error = error.message;
      appendEvent('submission_unknown', { batchId: run.id, jobId: job.id, detail: error.message });
      for (const laterJob of run.jobs.slice(index + 1)) {
        laterJob.state = 'skipped_after_unknown';
        laterJob.error = `未提交：${job.id} 的提交结果未知`;
      }
      saveRun(run);
      break;
    }
  }
  run.status = 'waiting_for_events';
  refreshQueueHealth(run);
  saveRun(run);
  return run.jobs.some((job) => job.state === 'submitted');
}
function ffprobe(path) {
  return JSON.parse(shell('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,nb_frames,duration', '-of', 'json', path]));
}
function runFilter(path, filter) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-i', path, '-vf', filter, '-f', 'null', '-'], { encoding: 'utf8' });
  return `${result.stdout || ''}\n${result.stderr || ''}`.split('\n').filter((line) => /blackdetect|freezedetect/i.test(line)).slice(-20);
}
function technicalQc(run, job) {
  const planPath = resolveFrom(run.batchPath, job.plan);
  const plan = readJson(planPath);
  const segment = plan.segments.find((entry) => entry.id === job.segment);
  const outputPath = resolveFrom(planPath, segment.output);
  if (!existsSync(outputPath)) throw new Error(`收片后缺少输出：${outputPath}`);
  const media = ffprobe(outputPath);
  const video = media.streams?.find((stream) => stream.codec_type === 'video');
  const expected = readJson(resolveFrom(planPath, plan.configPath)).expectedMedia || {};
  const reviewDir = resolve(runsDir, run.id, 'review');
  mkdirSync(reviewDir, { recursive: true });
  const contactSheet = resolve(reviewDir, `${job.id}-4fps.jpg`);
  shell('ffmpeg', ['-y', '-loglevel', 'error', '-i', outputPath, '-vf', 'fps=4,scale=256:-2,tile=4x3:padding=2:margin=0', '-frames:v', '1', contactSheet]);
  const report = {
    status: 'technical_qc_ready',
    releaseEligible: false,
    output: relativeFrom(run.batchPath, outputPath),
    outputSha256: sha256File(outputPath),
    media,
    expected: { width: expected.width ?? null, height: expected.height ?? null, fps: expected.fps ?? null },
    contactSheet: relativeFrom(run.batchPath, contactSheet),
    blackFrameSignals: runFilter(outputPath, 'blackdetect=d=0.1:pix_th=0.10'),
    frozenFrameSignals: runFilter(outputPath, 'freezedetect=n=0.001:d=0.3'),
    note: 'Technical checks only. Character, plot, action and lipsync require visual review.'
  };
  if ((expected.width && video?.width !== expected.width) || (expected.height && video?.height !== expected.height)) report.status = 'technical_qc_dimension_mismatch';
  writeJson(resolve(reviewDir, `${job.id}.technical-qc.json`), report);
  return report;
}
function collectCompleted(run, job) {
  const planPath = resolveFrom(run.batchPath, job.plan);
  shell(process.execPath, [rendererPath, 'collect', planPath, '--segment', job.segment]);
  job.technicalQc = technicalQc(run, job);
  job.output = job.technicalQc.output;
  job.state = 'needs_visual_qc';
  appendEvent('technical_qc_ready', { batchId: run.id, jobId: job.id, promptId: job.promptId, detail: job.technicalQc.status });
  saveRun(run);
}
function unpack(raw) {
  const parsed = JSON.parse(String(raw));
  if (Array.isArray(parsed)) return { event: parsed[0], data: parsed[1] ?? {} };
  return { event: parsed.type ?? parsed.event, data: parsed.data ?? parsed };
}
function allTerminal(run) { return run.jobs.every((job) => ['needs_visual_qc', 'failed', 'unknown', 'skipped_after_unknown'].includes(job.state)); }
function markFinished(run) {
  if (allTerminal(run)) run.status = run.jobs.some((job) => job.state === 'failed' || job.state === 'unknown') ? 'finished_with_failures' : 'needs_visual_qc';
  refreshQueueHealth(run);
  saveRun(run);
  if (allTerminal(run) && !run.batchFinishedAt) {
    run.batchFinishedAt = now();
    saveRun(run);
    appendEvent('batch_finished', { batchId: run.id, detail: run.status });
  }
}
function updateRuntime(run, job, event, data) {
  const timestamp = now();
  const previous = job.runtime ?? {};
  const runtime = { ...previous, lastEvent: event, lastEventAt: timestamp };
  if (event === 'execution_start') runtime.phase = 'running';
  if (event === 'executing' && data?.node != null) runtime.nodeId = String(data.node);
  if (event === 'progress') {
    runtime.phase = 'sampling';
    runtime.progress = { value: data?.value ?? null, max: data?.max ?? null, updatedAt: timestamp };
  }
  job.runtime = runtime;
  saveRun(run);
}
function watch(run) {
  const batch = loadBatch(run.batchPath);
  const firstPlan = resolveFrom(run.batchPath, batch.jobs[0].plan);
  const apiBase = readJson(resolveFrom(firstPlan, readJson(firstPlan).configPath)).apiBase;
  const wsBase = apiBase.replace(/^http/, 'ws');
  let reconnectTimer = null;
  const connect = () => {
    const socket = new WebSocket(`${wsBase}/ws?clientId=${encodeURIComponent(run.clientId)}`);
    socket.addEventListener('open', () => appendEvent('watcher_connected', { batchId: run.id }));
    socket.addEventListener('message', ({ data }) => {
      let message;
      try { message = unpack(data); } catch { return; }
      const promptId = message.data?.prompt_id ?? message.data?.promptId;
      const job = findRunJob(run, promptId);
      if (!job) return;
      if (['execution_start', 'executing', 'progress'].includes(message.event)) updateRuntime(run, job, message.event, message.data);
      if (message.event === 'execution_error') {
        job.state = 'failed';
        job.error = message.data?.exception_message ?? message.data?.error ?? 'ComfyUI execution_error';
        appendEvent('execution_error', { batchId: run.id, jobId: job.id, promptId, detail: job.error });
        saveRun(run); markFinished(run);
      }
      if (message.event === 'execution_success' || (message.event === 'executing' && message.data?.node == null)) {
        if (job.state !== 'submitted') return;
        job.state = 'collecting'; saveRun(run);
        try { collectCompleted(run, job); } catch (error) {
          job.state = 'unknown'; job.error = error.message; appendEvent('collect_failed', { batchId: run.id, jobId: job.id, promptId, detail: error.message }); saveRun(run);
        }
        markFinished(run);
      }
    });
    socket.addEventListener('close', () => {
      if (allTerminal(run)) return;
      appendEvent('watcher_disconnected', { batchId: run.id });
      reconnectTimer = setTimeout(connect, 3000);
    });
    socket.addEventListener('error', () => appendEvent('watcher_socket_error', { batchId: run.id }));
  };
  process.on('SIGINT', () => { if (reconnectTimer) clearTimeout(reconnectTimer); process.exit(0); });
  connect();
}
function showStatus(batchFile, batch) {
  const run = loadRun(batch.id);
  console.log(JSON.stringify(run ?? { id: batch.id, status: 'not_started' }, null, 2));
}
function showHealth(batchFile, batch) {
  const run = loadRun(batch.id);
  if (!run) return console.log(JSON.stringify({ id: batch.id, state: 'not_started', minimumStartJobs, targetTrackedJobs }, null, 2));
  refreshQueueHealth(run);
  saveRun(run);
  console.log(JSON.stringify({ id: run.id, status: run.status, queueHealth: run.queueHealth, jobs: run.jobs.map((job) => ({ id: job.id, state: job.state, promptId: job.promptId, runtime: job.runtime, visualReview: job.visualReview })) }, null, 2));
}

function resume(run) {
  let shouldWatch = false;
  for (const job of run.jobs) {
    if (job.state !== 'submitted') continue;
    const planPath = resolveFrom(run.batchPath, job.plan);
    shell(process.execPath, [rendererPath, 'collect', planPath, '--segment', job.segment]);
    const plan = readJson(planPath);
    const segment = plan.segments.find((entry) => entry.id === job.segment);
    if (segment?.status === 'succeeded') {
      job.state = 'collecting';
      saveRun(run);
      try { collectCompleted(run, job); }
      catch (error) {
        job.state = 'unknown';
        job.error = error.message;
        appendEvent('collect_failed', { batchId: run.id, jobId: job.id, promptId: job.promptId, detail: error.message });
        saveRun(run);
      }
    } else if (segment?.status === 'failed') {
      job.state = 'failed';
      job.error = segment.error?.message ?? 'ComfyUI reported failed';
      appendEvent('execution_error', { batchId: run.id, jobId: job.id, promptId: job.promptId, detail: job.error });
      saveRun(run);
    } else {
      shouldWatch = true;
    }
  }
  markFinished(run);
  if (shouldWatch) watch(run);
}

if (!['validate', 'start', 'status', 'health', 'resume'].includes(command)) usage();
const file = batchPath();
if (!existsSync(file)) fail(`找不到批次文件：${file}`);
const batch = loadBatch(file);
if (command === 'validate') console.log(JSON.stringify({ id: batch.id, jobs: validate(file, batch) }, null, 2));
if (command === 'status') showStatus(file, batch);
if (command === 'health') showHealth(file, batch);
if (command === 'resume') {
  const run = loadRun(batch.id);
  if (!run) fail(`批次没有运行记录：${batch.id}`);
  resume(run);
}
if (command === 'start') {
  if (!hasFlag('--confirm-gpu')) fail('启动 GPU 批次必须显式添加 --confirm-gpu');
  if (batch.testOnly) fail('测试批次不能启动 GPU');
  if (loadRun(batch.id)) fail(`批次已有运行记录：${batch.id}`);
  const run = newRun(file, batch, validate(file, batch));
  saveRun(run);
  if (submitAll(run)) watch(run);
  else markFinished(run);
}
