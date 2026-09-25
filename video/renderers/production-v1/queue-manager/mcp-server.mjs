#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const managerDir = dirname(fileURLToPath(import.meta.url));
const managerPath = resolve(managerDir, 'comfy-batch-manager.mjs');
const runsDir = resolve(managerDir, 'runs');
const eventsPath = resolve(managerDir, 'events.jsonl');
const supervisorStatusPath = resolve(managerDir, 'supervisor-status.json');
const projectRoot = resolve(managerDir, '..', '..', '..', '..');

function resolveProjectPath(candidate) {
  const path = resolve(projectRoot, candidate);
  if (!path.startsWith(`${projectRoot}/`)) throw new Error('路径必须位于当前项目内');
  return path;
}
function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function execute(parameters) {
  const result = spawnSync(process.execPath, [managerPath, ...parameters], { cwd: managerDir, encoding: 'utf8' });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'manager failed').trim());
  return result.stdout.trim();
}
function text(value) { return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] }; }
function loadRun(batchId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(batchId)) throw new Error('批次 id 格式无效');
  const path = resolve(runsDir, `${batchId}.json`);
  if (!existsSync(path)) return null;
  return readJson(path);
}
const server = new McpServer({ name: 'manju-comfy-queue', version: '0.1.0' });

server.registerTool('prepare_batch', {
  description: 'Validate up to three reviewed ComfyUI jobs before any GPU submission. Checks plan state, source image SHA256 and workflow configuration.',
  inputSchema: { batch_path: z.string().min(1) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}, async ({ batch_path }) => text(execute(['validate', '--batch', resolveProjectPath(batch_path)])));

server.registerTool('submit_verified_batch', {
  description: 'Start an event-driven batch of one to three prevalidated ComfyUI jobs. A single reviewed job may start immediately; the supervisor can roll in later reviewed batches. The manager submits each explicit segment once and never retries unknown results.',
  inputSchema: { batch_path: z.string().min(1), confirm_gpu: z.literal(true) },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
}, async ({ batch_path }) => {
  const batch = resolveProjectPath(batch_path);
  if (readJson(batch).testOnly) throw new Error('测试批次不能提交 GPU');
  execute(['validate', '--batch', batch]);
  const child = spawn(process.execPath, [managerPath, 'start', '--batch', batch, '--confirm-gpu'], {
    cwd: managerDir,
    detached: true,
    stdio: ['ignore', openSync(resolve(managerDir, 'manager.out'), 'a'), openSync(resolve(managerDir, 'manager.err'), 'a')]
  });
  child.unref();
  return text({ started: true, pid: child.pid, batch_path: batch_path });
});

server.registerTool('resume_batch', {
  description: 'Recover a previously submitted event batch using its recorded prompt IDs. It never submits a new GPU task.',
  inputSchema: { batch_path: z.string().min(1) },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}, async ({ batch_path }) => {
  const batch = resolveProjectPath(batch_path);
  const child = spawn(process.execPath, [managerPath, 'resume', '--batch', batch], {
    cwd: managerDir,
    detached: true,
    stdio: ['ignore', openSync(resolve(managerDir, 'manager.out'), 'a'), openSync(resolve(managerDir, 'manager.err'), 'a')]
  });
  child.unref();
  return text({ resumed: true, pid: child.pid, batch_path });
});

server.registerTool('get_batch_status', {
  description: 'Read durable status for a started batch without querying the ComfyUI queue.',
  inputSchema: { batch_id: z.string().min(1) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}, async ({ batch_id }) => text(loadRun(batch_id) ?? { id: batch_id, status: 'not_started' }));

server.registerTool('get_batch_health', {
  description: 'Read durable queue-reserve health. One reviewed job may run immediately while the supervisor targets two tracked jobs, without querying or changing the ComfyUI queue.',
  inputSchema: { batch_path: z.string().min(1) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}, async ({ batch_path }) => text(execute(['health', '--batch', resolveProjectPath(batch_path)])));

server.registerTool('get_production_progress', {
  description: 'Read the local supervisor snapshot: tracked jobs, active prompt progress, reviewed reserve, idle or possible-stall state. Episode-level shot progress belongs to the project.',
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}, async () => text(existsSync(supervisorStatusPath) ? readJson(supervisorStatusPath) : { state: 'not_started' }));

server.registerTool('wait_events', {
  description: 'Read new persisted ComfyUI completion and error events after a numeric cursor. It never polls the ComfyUI queue.',
  inputSchema: { cursor: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(30) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}, async ({ cursor, limit }) => {
  const lines = existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean) : [];
  const slice = lines.slice(cursor, cursor + limit).map((line) => JSON.parse(line));
  return text({ cursor, next_cursor: cursor + slice.length, events: slice });
});

server.registerTool('get_review_bundle', {
  description: 'Return technical QC, output and contact-sheet paths for a completed job. Visual acceptance remains separate.',
  inputSchema: { batch_id: z.string().min(1), job_id: z.string().min(1) },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}, async ({ batch_id, job_id }) => {
  const run = loadRun(batch_id);
  const job = run?.jobs?.find((item) => item.id === job_id);
  if (!job) throw new Error('找不到批次任务');
  return text(job);
});

server.registerTool('record_visual_review', {
  description: 'Record a human visual review. It does not requeue, replace, edit or delete media.',
  inputSchema: { batch_id: z.string().min(1), job_id: z.string().min(1), decision: z.enum(['approved_visual_only', 'rejected_visual']), reason: z.string().min(1) },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
}, async ({ batch_id, job_id, decision, reason }) => {
  const path = resolve(runsDir, `${batch_id}.json`);
  const run = loadRun(batch_id);
  const job = run?.jobs?.find((item) => item.id === job_id);
  if (!job) throw new Error('找不到批次任务');
  job.visualReview = { decision, reason, recordedAt: new Date().toISOString() };
  run.updatedAt = new Date().toISOString();
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await import('node:fs/promises').then(({ writeFile, rename }) => writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`).then(() => rename(temporary, path)));
  return text(job);
});

await server.connect(new StdioServerTransport());
