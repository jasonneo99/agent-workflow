import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discardGuideEvidenceReductionCheckpoint, guideEvidenceCheckpointStorageKey, loadOrCreateGuideEvidenceCheckpointKey, persistGuideEvidenceReductionCheckpoint, readGuideEvidenceReductionCheckpoint } from './guide-evidence-checkpoint-store.js';

test('Guide reduction checkpoint key is stable, private, and project storage keys disclose no project id', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentflow-guide-key-'));
  try {
    const [first, second] = await Promise.all([loadOrCreateGuideEvidenceCheckpointKey(root), loadOrCreateGuideEvidenceCheckpointKey(root)]);
    assert.equal(first.length, 32);
    assert.deepEqual(second, first);
    const target = path.join(root, '.agent-workflow', 'runtime', 'guide-evidence-checkpoint.key');
    assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
    const storageKey = guideEvidenceCheckpointStorageKey('private-project-identity');
    assert.match(storageKey, /^agentflow:guide-evidence-reduction:[a-f0-9]{24}$/u);
    assert.doesNotMatch(storageKey, /private-project-identity/u);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Guide reduction checkpoint key refuses symlinks and broad permissions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentflow-guide-key-'));
  const runtime = path.join(root, '.agent-workflow', 'runtime');
  try {
    await fs.mkdir(runtime, { recursive: true });
    const target = path.join(runtime, 'guide-evidence-checkpoint.key');
    await fs.writeFile(target, `${Buffer.alloc(32, 1).toString('base64url')}\n`, { mode: 0o644 });
    await assert.rejects(() => loadOrCreateGuideEvidenceCheckpointKey(root), /owner-only/);
    await fs.rm(target);
    await fs.symlink(path.join(root, 'missing-key'), target);
    await assert.rejects(() => loadOrCreateGuideEvidenceCheckpointKey(root), /regular local file|ELOOP/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Guide reduction checkpoint handles stay small, authenticated, project-bound, and disposable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentflow-guide-handle-'));
  try {
    const signingKey = await loadOrCreateGuideEvidenceCheckpointKey(root), checkpoint = 'bounded-authenticated-checkpoint', expiresAt = new Date(Date.now() + 60_000).toISOString();
    const handle = await persistGuideEvidenceReductionCheckpoint({ rootDir: root, projectId: 'project-a', checkpoint, expiresAt, signingKey });
    assert.ok(handle.length < 300);
    assert.equal(await readGuideEvidenceReductionCheckpoint({ rootDir: root, projectId: 'project-a', handle, signingKey }), checkpoint);
    assert.equal((await fs.readdir(path.join(root, '.agent-workflow', 'runtime', 'guide-evidence-checkpoints'))).length, 1);
    assert.doesNotMatch(handle, /bounded-authenticated-checkpoint/);
    await assert.rejects(() => readGuideEvidenceReductionCheckpoint({ rootDir: root, projectId: 'project-b', handle, signingKey }), /binding is invalid/);
    const [body, signature] = handle.split('.');
    await assert.rejects(() => readGuideEvidenceReductionCheckpoint({ rootDir: root, projectId: 'project-a', handle: `${body}0.${signature}`, signingKey }), /authentication failed/);
    await discardGuideEvidenceReductionCheckpoint({ rootDir: root, projectId: 'project-a', handle, signingKey });
    await assert.rejects(() => readGuideEvidenceReductionCheckpoint({ rootDir: root, projectId: 'project-a', handle, signingKey }), /unavailable/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
