#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..', '..', '..', '..');
const args = process.argv.slice(2);
const allowedStages = new Set([
  'blocked', 'design_ready', 'keyframe_ready', 'generation_ready', 'submitted',
  'generated', 'technical_pass', 'single_shot_pass', 'continuity_pass',
  'adopted', 'review_pending', 'rejected'
]);

function value(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}
function has(name) { return args.includes(name); }
function fail(message) { throw new Error(message); }
function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function sha256(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function resolveAsset(shotsPath, candidate) {
  if (!candidate) return null;
  if (isAbsolute(candidate)) return candidate;
  const fromProject = resolve(projectRoot, candidate);
  return existsSync(fromProject) ? fromProject : resolve(dirname(shotsPath), candidate);
}
function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(`缺少 ${label}`);
}
function verifyAsset(shotsPath, asset, label) {
  if (!asset || typeof asset !== 'object') fail(`缺少 ${label}`);
  requireText(asset.path, `${label}.path`);
  requireText(asset.sha256, `${label}.sha256`);
  const path = resolveAsset(shotsPath, asset.path);
  if (!existsSync(path)) fail(`${label} 文件不存在：${path}`);
  const actual = sha256(path);
  if (actual !== asset.sha256) fail(`${label} SHA256 不匹配：${path}`);
  return { path, sha256: actual };
}

const shotsArg = value('--shots');
if (!shotsArg) fail('用法：validate-sequence.mjs --shots <shots.json> [--shot-id <id>] [--require-generation-ready]');
const shotsPath = resolve(shotsArg);
if (!existsSync(shotsPath)) fail(`镜头表不存在：${shotsPath}`);
const document = readJson(shotsPath);
if (document.schema !== 'manju.director-shot-list/v1') fail('镜头表 schema 必须是 manju.director-shot-list/v1');
requireText(document.sequenceId, 'sequenceId');
if (!document.direction || typeof document.direction !== 'object') fail('缺少 direction');
requireText(document.direction.segmentPurpose, 'direction.segmentPurpose');
if (!Array.isArray(document.direction.audienceMustUnderstand) || document.direction.audienceMustUnderstand.length < 1) fail('direction.audienceMustUnderstand 至少一项');
if (!Array.isArray(document.shots) || document.shots.length < 1) fail('shots 至少一镜');

const requestedShotId = value('--shot-id');
const selected = requestedShotId ? document.shots.filter((shot) => shot.id === requestedShotId) : document.shots;
if (requestedShotId && selected.length !== 1) fail(`找不到镜头：${requestedShotId}`);
const ids = new Set();
const report = [];

for (const shot of document.shots) {
  requireText(shot.id, 'shot.id');
  if (ids.has(shot.id)) fail(`镜头 id 重复：${shot.id}`);
  ids.add(shot.id);
}

for (const shot of selected) {
  if (!allowedStages.has(shot.stage)) fail(`${shot.id} stage 无效：${shot.stage}`);
  requireText(shot.storyPurpose, `${shot.id}.storyPurpose`);
  requireText(shot.startState, `${shot.id}.startState`);
  requireText(shot.endState, `${shot.id}.endState`);
  requireText(shot.performance?.objective, `${shot.id}.performance.objective`);
  requireText(shot.performance?.emotion, `${shot.id}.performance.emotion`);
  requireText(shot.performance?.visibleBehavior, `${shot.id}.performance.visibleBehavior`);
  requireText(shot.spatialRelation?.screenDirection, `${shot.id}.spatialRelation.screenDirection`);
  requireText(shot.spatialRelation?.target, `${shot.id}.spatialRelation.target`);
  requireText(shot.cameraIntent?.shotSize, `${shot.id}.cameraIntent.shotSize`);
  requireText(shot.cameraIntent?.reason, `${shot.id}.cameraIntent.reason`);
  requireText(shot.cameraIntent?.movement, `${shot.id}.cameraIntent.movement`);
  if (/close|特写|近景/i.test(shot.cameraIntent.shotSize)) requireText(shot.cameraIntent.closeupJustification, `${shot.id}.cameraIntent.closeupJustification`);
  if (!Array.isArray(shot.continuityChecks) || shot.continuityChecks.length < 2) fail(`${shot.id}.continuityChecks 至少两项`);
  if (!Array.isArray(shot.references) || shot.references.length < 1) fail(`${shot.id}.references 至少一项`);
  const verifiedReferences = shot.references.map((asset, index) => verifyAsset(shotsPath, asset, `${shot.id}.references[${index}]`));
  let verifiedAudio = null;
  if (shot.audio) verifiedAudio = verifyAsset(shotsPath, shot.audio, `${shot.id}.audio`);
  if (has('--require-generation-ready')) {
    if (shot.stage !== 'generation_ready') fail(`${shot.id} 当前为 ${shot.stage}，未达到 generation_ready`);
    if (shot.keyframeReviewStatus !== 'approved') fail(`${shot.id} 关键帧未通过`);
    if (shot.continuityReadiness !== 'approved') fail(`${shot.id} 连续性准备未通过`);
    if (shot.audio && shot.audio.reviewStatus !== 'approved') fail(`${shot.id} 音频未通过听审`);
  }
  report.push({
    id: shot.id,
    stage: shot.stage,
    references: verifiedReferences,
    audio: verifiedAudio,
    generationReady: shot.stage === 'generation_ready' && shot.keyframeReviewStatus === 'approved' && shot.continuityReadiness === 'approved' && (!shot.audio || shot.audio.reviewStatus === 'approved')
  });
}

process.stdout.write(`${JSON.stringify({ ok: true, sequenceId: document.sequenceId, shotsPath, report }, null, 2)}\n`);
