import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(resolve(tmpdir(), 'manju-kit-test-'));
const put = (name, value) => { const path = resolve(temp, name); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); return path; };
const run = (script, args) => spawnSync(process.execPath, [resolve(root, script), ...args], { encoding: 'utf8' });

try {
  const image = put('source.txt', 'offline fixture; never submit');
  const hash = createHash('sha256').update('offline fixture; never submit').digest('hex');
  const shots = put('shots.json', {
    schema: 'manju.director-shot-list/v1', sequenceId: 'TEST',
    direction: { segmentPurpose: '离线预检', audienceMustUnderstand: ['不提交 GPU'] },
    shots: [{
      id: 'S01', stage: 'generation_ready', storyPurpose: '建立事件', startState: '未行动', endState: '已行动',
      performance: { objective: '行动', emotion: '坚定', visibleBehavior: '起步' },
      spatialRelation: { screenDirection: '左到右', target: '门' },
      cameraIntent: { shotSize: 'medium shot', reason: '建立关系', movement: '固定' },
      continuityChecks: ['方向不变', '位置一致'], references: [{ path: image, sha256: hash }],
      keyframeReviewStatus: 'approved', continuityReadiness: 'approved'
    }]
  });
  const validator = '.agents/skills/manju-production/scripts/validate-sequence.mjs';
  assert.equal(run(validator, ['--shots', shots, '--require-generation-ready']).status, 0);

  const workflow = put('workflow.json', { 1: { inputs: { image: '' } }, 2: { inputs: { text: '' } } });
  const config = put('config.json', {
    schema: 'manju.comfyui-wan-i2v-config/v1', apiBase: 'http://127.0.0.1:6006', workflowApiPath: workflow,
    bindings: { image: { nodeId: '1', input: 'image' }, positive: { nodeId: '2', input: 'text' } }
  });
  const plan = put('plan.json', {
    schema: 'manju.comfyui-wan-i2v-render-plan/v1', configPath: config,
    segments: [{ id: 'S01', durationSeconds: 3, sourceImage: image, sourceImageSha256: hash, prompt: 'walk', status: 'not_submitted' }]
  });
  const renderer = 'video/renderers/comfyui-wan-i2v.mjs';
  assert.equal(run(renderer, ['validate', plan]).status, 0);
  const batch = put('batch.json', {
    schema: 'manju.comfyui-event-batch/v1', id: 'offline-test', admission: { reviewedAt: new Date().toISOString() },
    jobs: [{
      id: 'S01', plan, segment: 'S01', productionShot: shots, shotId: 'S01',
      gpuReviewed: true, reviewNotes: '离线测试准入字段',
      qualityGate: { nativeDetailReviewed: true, sourceCropUpscaleRatio: 1, visibleIdentity: false }
    }]
  });
  const manager = 'video/renderers/production-v1/queue-manager/comfy-batch-manager.mjs';
  assert.equal(run(manager, ['validate', '--batch', batch]).status, 0);
  assert.notEqual(run(manager, ['start', '--batch', batch]).status, 0); // explicit GPU confirmation required
  writeFileSync(image, 'changed source');
  assert.notEqual(run(validator, ['--shots', shots, '--require-generation-ready']).status, 0);
  assert.notEqual(run(renderer, ['validate', plan]).status, 0);
  assert.notEqual(run(manager, ['validate', '--batch', batch]).status, 0);
  console.log('离线准入、节点绑定、源图哈希检查通过；未连接 GPU。');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
