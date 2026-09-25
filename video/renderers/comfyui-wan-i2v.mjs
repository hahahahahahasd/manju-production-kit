#!/usr/bin/env node

/**
 * Project-local ComfyUI/Wan image-to-video renderer.
 *
 * It turns a reviewed, project-local video plan into explicitly confirmed
 * ComfyUI jobs over a local tunnel.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path';

const [command, planArg, ...args] = process.argv.slice(2);
const projectDir = resolve(dirname(new URL(import.meta.url).pathname), '..', '..');
const defaultConfigPath = resolve(projectDir, 'video', 'renderers', 'comfyui-wan-i2v.config.example.json');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function usage() {
  fail(`用法：
  node video/renderers/comfyui-wan-i2v.mjs init <MiniMax计划.json> --out <Comfy计划.json> [--config <配置.json>]
  node video/renderers/comfyui-wan-i2v.mjs validate <Comfy计划.json>
  node video/renderers/comfyui-wan-i2v.mjs status <Comfy计划.json>
  node video/renderers/comfyui-wan-i2v.mjs submit <Comfy计划.json> --segment <镜头ID> --confirm-gpu
  node video/renderers/comfyui-wan-i2v.mjs collect <Comfy计划.json> --segment <镜头ID>

submit 只允许一段，且绝不自动重试；collect 只查询/下载，不会提交新任务。`);
}

function flag(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporaryPath, path);
}

function now() {
  return new Date().toISOString();
}

function resolveFrom(basePath, candidate) {
  return isAbsolute(candidate) ? candidate : resolve(dirname(basePath), candidate);
}

function relativeFrom(basePath, targetPath) {
  const result = relative(dirname(basePath), targetPath);
  return result || '.';
}

function requireFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) fail(`缺少${label}：${path}`);
  return path;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function loadConfig(planPath, plan) {
  const configuredPath = plan.configPath || defaultConfigPath;
  const configPath = resolveFrom(planPath, configuredPath);
  const config = readJson(requireFile(configPath, 'ComfyUI 配置'));
  if (config.schema !== 'manju.comfyui-wan-i2v-config/v1') fail('ComfyUI 配置 schema 不正确');
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(config.apiBase || '')) {
    fail('为避免把实例暴露到公网，apiBase 只能是本机 localhost/127.0.0.1 地址');
  }
  if (!config.workflowApiPath) fail('ComfyUI 配置缺少 workflowApiPath');
  const workflowPath = resolveFrom(configPath, config.workflowApiPath);
  const bindings = config.bindings || {};
  for (const key of ['image', 'positive']) {
    if (!bindings[key]?.nodeId || !bindings[key]?.input) fail(`ComfyUI 配置缺少 bindings.${key}`);
  }
  return { configPath, config, workflowPath, bindings };
}

function getSegment(plan, id) {
  const segment = plan.segments?.find((item) => item.id === id);
  if (!segment) fail(`计划中没有段落：${id}`);
  return segment;
}

function normalizeSourcePlan(sourcePath, sourcePlan, outPath, configPath) {
  if (!Array.isArray(sourcePlan.segments) || sourcePlan.segments.length === 0) fail('源计划没有 segments');
  const segments = sourcePlan.segments.map((source) => {
    const firstImage = source.references?.find((item) => item.type === 'image')?.path;
    if (!firstImage) fail(`${source.id || '未知段落'} 缺少第一张参考图`);
    const sourceImage = resolveFrom(sourcePath, firstImage);
    return {
      id: source.id,
      episode: source.episode ?? null,
      durationSeconds: Number(source.duration || source.sourceSeconds || 0),
      prompt: source.prompt,
      negativePrompt: 'text, watermark, logo, subtitles, modern objects, extra people, distorted hands, extra fingers, deformed face, flicker, jitter, audible speech',
      sourceImage: relativeFrom(outPath, sourceImage),
      sourcePlan: { path: relativeFrom(outPath, sourcePath), sourceSegmentId: source.id },
      output: `clips/${source.id}.mp4`,
      status: 'not_submitted',
      attempts: 0,
      submission: null,
      download: null,
      error: null
    };
  });
  return {
    schema: 'manju.comfyui-wan-i2v-render-plan/v1',
    provider: 'comfyui',
    renderer: 'wan-i2v',
    createdAt: now(),
    updatedAt: now(),
    sourcePlan: relativeFrom(outPath, sourcePath),
    configPath: relativeFrom(outPath, configPath),
    segments
  };
}

function setBinding(workflow, binding, value) {
  const node = workflow[String(binding.nodeId)];
  if (!node?.inputs) fail(`API 工作流中没有节点 ${binding.nodeId}`);
  if (!(binding.input in node.inputs)) fail(`节点 ${binding.nodeId} 不含输入 ${binding.input}`);
  node.inputs[binding.input] = value;
}

function durationValue(binding, seconds) {
  if (!binding || !Number.isFinite(seconds) || seconds <= 0) return null;
  if ((binding.unit || 'seconds') === 'seconds') return seconds;
  if (binding.unit === 'frames') {
    const fps = Number(binding.fps || 16);
    const frameOffset = Number(binding.frameOffset || 0);
    if (!(fps > 0)) fail('duration.fps 必须为正数');
    return Math.round(seconds * fps) + frameOffset;
  }
  fail(`不支持的 duration.unit：${binding.unit}`);
}

function buildPrompt(planPath, plan, segment) {
  const { config, workflowPath, bindings } = loadConfig(planPath, plan);
  requireFile(workflowPath, 'API 工作流 JSON');
  const sourceImage = resolveFrom(planPath, segment.sourceImage);
  requireFile(sourceImage, '分镜图');
  const workflow = structuredClone(readJson(workflowPath));
  setBinding(workflow, bindings.image, segment.uploadedImage);
  setBinding(workflow, bindings.positive, segment.prompt);
  if (bindings.negative && segment.negativePrompt) setBinding(workflow, bindings.negative, segment.negativePrompt);
  const targetDuration = durationValue(bindings.duration, segment.durationSeconds);
  if (targetDuration !== null) {
    setBinding(workflow, bindings.duration, targetDuration);
  }
  if (bindings.seed) setBinding(workflow, bindings.seed, segment.seed ?? Math.floor(Math.random() * 2 ** 31));
  if (bindings.filenamePrefix) setBinding(workflow, bindings.filenamePrefix, `manju/${segment.id}/${Date.now()}`);
  return { config, workflow, sourceImage };
}

async function fetchJson(url, options = {}, timeoutMs = 30_000) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 800) }; }
  if (!response.ok) {
    const error = new Error(body?.error?.message || body?.error || `${response.status} ${response.statusText}`);
    error.httpStatus = response.status;
    throw error;
  }
  return body;
}

async function uploadImage(apiBase, sourceImage, segmentId) {
  const extension = extname(sourceImage).toLowerCase();
  const contentType = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[extension];
  if (!contentType) fail(`不支持的分镜图格式：${extension}`);
  const uploadName = `${segmentId}-${sha256(`${sourceImage}:${Date.now()}:${randomUUID()}`).slice(0, 12)}${extension}`;
  const form = new FormData();
  form.set('image', new Blob([readFileSync(sourceImage)], { type: contentType }), uploadName);
  form.set('overwrite', 'true');
  const response = await fetchJson(`${apiBase}/upload/image`, { method: 'POST', body: form }, 120_000);
  if (!response.name) fail('ComfyUI 上传未返回文件名');
  return response;
}

function collectVideoFiles(historyEntry) {
  const files = [];
  for (const output of Object.values(historyEntry?.outputs || {})) {
    for (const value of Object.values(output || {})) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        const filename = String(item?.filename || '');
        if (/\.(mp4|webm|mov)$/i.test(filename)) files.push(item);
      }
    }
  }
  return files;
}

async function readHistory(apiBase, promptId) {
  const history = await fetchJson(`${apiBase}/history/${encodeURIComponent(promptId)}`);
  return history[promptId] || null;
}

function statusFromHistory(entry) {
  if (!entry) return 'running';
  const status = entry.status?.status_str;
  if (status === 'success') return 'succeeded';
  if (status === 'error') return 'failed';
  return 'running';
}

async function init() {
  const sourcePath = planArg ? resolve(planArg) : null;
  const outPath = flag('--out') ? resolve(flag('--out')) : null;
  const configPath = flag('--config') ? resolve(flag('--config')) : defaultConfigPath;
  if (!sourcePath || !outPath) usage();
  requireFile(sourcePath, '源投产计划');
  requireFile(configPath, 'ComfyUI 配置');
  mkdirSync(dirname(outPath), { recursive: true });
  if (existsSync(outPath)) fail(`拒绝覆盖已有计划：${outPath}`);
  const plan = normalizeSourcePlan(sourcePath, readJson(sourcePath), outPath, configPath);
  writeJson(outPath, plan);
  console.log(`已创建 ComfyUI 计划：${outPath}`);
  console.log(`段落数：${plan.segments.length}；请先运行 validate，再只提交一段样片。`);
}

function validate(planPath, plan) {
  if (plan.schema !== 'manju.comfyui-wan-i2v-render-plan/v1') fail('不是 ComfyUI/Wan 投产计划');
  const { configPath, workflowPath, bindings } = loadConfig(planPath, plan);
  requireFile(workflowPath, 'API 工作流 JSON');
  const workflow = readJson(workflowPath);
  for (const [name, binding] of Object.entries(bindings)) {
    if (!binding) continue;
    const node = workflow[String(binding.nodeId)];
    if (!node?.inputs || !(binding.input in node.inputs)) fail(`工作流绑定 ${name} 指向不存在的节点或输入：${binding.nodeId}.${binding.input}`);
  }
  const invalid = [];
  for (const segment of plan.segments || []) {
    if (!segment.id || !segment.prompt?.trim()) invalid.push(`${segment.id || '未知段落'} 缺少 id 或提示词`);
    if (!(segment.durationSeconds > 0)) invalid.push(`${segment.id} 时长无效`);
    const sourceImage = resolveFrom(planPath, segment.sourceImage || '');
    if (!existsSync(sourceImage)) invalid.push(`${segment.id} 缺少分镜图：${sourceImage}`);
    else if (segment.sourceImageSha256 && sha256(readFileSync(sourceImage)) !== segment.sourceImageSha256) invalid.push(`${segment.id} 源图 SHA256 不匹配`);
  }
  if (invalid.length) fail(`计划校验失败：\n- ${invalid.join('\n- ')}`);
  console.log(`计划校验通过：${plan.segments.length} 段；配置：${configPath}`);
  console.log(`API 工作流：${workflowPath}`);
}

async function submit(planPath, plan) {
  const segmentId = flag('--segment');
  if (!segmentId || !args.includes('--confirm-gpu')) usage();
  validate(planPath, plan);
  const segment = getSegment(plan, segmentId);
  if (segment.status !== 'not_submitted') fail(`${segment.id} 当前状态是 ${segment.status}，拒绝重复提交`);
  const { config, sourceImage } = buildPrompt(planPath, plan, segment);
  try {
    const uploaded = await uploadImage(config.apiBase, sourceImage, segment.id);
    segment.uploadedImage = uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
    const seedBinding = loadConfig(planPath, plan).bindings.seed;
    if (seedBinding && segment.seed === undefined) segment.seed = Math.floor(Math.random() * 2 ** 31);
    const finalPrompt = buildPrompt(planPath, plan, segment).workflow;
    const clientId = flag('--client-id') || `manju-${randomUUID()}`;
    const request = { prompt: finalPrompt, client_id: clientId };
    segment.status = 'submitting';
    segment.submission = { requestedAt: now(), requestSha256: sha256(JSON.stringify(request)), promptId: null };
    plan.updatedAt = now();
    writeJson(planPath, plan);
    const accepted = await fetchJson(`${config.apiBase}/prompt`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request)
    });
    if (!accepted.prompt_id) fail('ComfyUI 未返回 prompt_id');
    segment.status = 'submitted';
    segment.attempts = Number(segment.attempts || 0) + 1;
    segment.submission = { ...segment.submission, promptId: accepted.prompt_id, clientId, acceptedAt: now() };
    plan.updatedAt = now();
    writeJson(planPath, plan);
    console.log(`已提交 ${segment.id}：${accepted.prompt_id}`);
    console.log('请随后运行 collect；该命令只查询并下载，不会再次提交。');
  } catch (error) {
    const unknown = !error.httpStatus || error.httpStatus >= 500 || error.name === 'TimeoutError' || error.name === 'AbortError';
    segment.status = unknown ? 'unknown' : 'failed';
    segment.error = { message: error.message, httpStatus: error.httpStatus || null, at: now() };
    plan.updatedAt = now();
    writeJson(planPath, plan);
    fail(`${unknown ? '提交结果未知；禁止自动重试' : '提交失败'}：${error.message}`);
  }
}

async function collect(planPath, plan) {
  const segmentId = flag('--segment');
  if (!segmentId) usage();
  validate(planPath, plan);
  const segment = getSegment(plan, segmentId);
  const promptId = segment.submission?.promptId;
  if (!promptId) fail(`${segment.id} 尚未提交，没有 prompt_id`);
  const { config } = loadConfig(planPath, plan);
  try {
    const entry = await readHistory(config.apiBase, promptId);
    const status = statusFromHistory(entry);
    segment.status = status;
    segment.checkedAt = now();
    if (status === 'succeeded') {
      const file = collectVideoFiles(entry)[0];
      if (!file) fail('任务显示成功，但历史记录中没有视频输出');
      const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || '', type: file.type || 'output' });
      const response = await fetch(`${config.apiBase}/view?${query}`, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) fail(`下载视频失败：${response.status}`);
      const outputPath = resolveFrom(planPath, segment.output);
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, Buffer.from(await response.arrayBuffer()));
      segment.download = { status: 'succeeded', output: relativeFrom(planPath, outputPath), downloadedAt: now() };
      console.log(`已下载：${outputPath}`);
    }
    plan.updatedAt = now();
    writeJson(planPath, plan);
    console.log(`status=${status}`);
  } catch (error) {
    segment.error = { message: error.message, httpStatus: error.httpStatus || null, at: now() };
    plan.updatedAt = now();
    writeJson(planPath, plan);
    fail(`查询/下载失败：${error.message}`);
  }
}

function status(planPath, plan) {
  if (plan.schema !== 'manju.comfyui-wan-i2v-render-plan/v1') fail('不是 ComfyUI/Wan 投产计划');
  for (const segment of plan.segments || []) {
    console.log(`${segment.id}\t${segment.status}\t${segment.submission?.promptId || '-'}\t${segment.output}`);
  }
}

if (!['init', 'validate', 'status', 'submit', 'collect'].includes(command) || !planArg) usage();
const planPath = resolve(planArg);
if (command === 'init') await init();
else {
  requireFile(planPath, 'ComfyUI 计划');
  const plan = readJson(planPath);
  if (command === 'validate') validate(planPath, plan);
  if (command === 'status') status(planPath, plan);
  if (command === 'submit') await submit(planPath, plan);
  if (command === 'collect') await collect(planPath, plan);
}
