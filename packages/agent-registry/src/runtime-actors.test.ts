import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { missingRuntimeReceiptActors, runtimeReceiptActorReferences } from './runtime-actors.js';

test('runtime receipt actor discovery finds literal writers and ignores tests and dynamic task agents', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentflow-runtime-actors-'));
  try {
    await fs.mkdir(path.join(root, 'packages/example'), { recursive: true });
    await fs.writeFile(path.join(root, 'packages/example/index.ts'), `appendActionReceipt(client,{agentId:'workflow-guide'}); recordRunAction({agentId: task.agentId}); recordRunAction({agentId:"workflow-orchestrator"});`);
    await fs.writeFile(path.join(root, 'packages/example/index.test.ts'), `recordRunAction({agentId:'missing-test-agent'});`);
    const references = await runtimeReceiptActorReferences(root);
    assert.deepEqual(references.map(item => item.agentId), ['workflow-guide', 'workflow-orchestrator']);
    assert.deepEqual(missingRuntimeReceiptActors(references, new Set(['workflow-orchestrator'])).map(item => item.agentId), ['workflow-guide']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
