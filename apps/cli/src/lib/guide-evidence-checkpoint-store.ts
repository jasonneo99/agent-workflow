import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const keyFileName = 'guide-evidence-checkpoint.key';
const checkpointDirectoryName = 'guide-evidence-checkpoints';
const projectHash = (projectId: string) => createHash('sha256').update(projectId).digest('hex');
const handleSignature = (body: string, key: Buffer) => createHmac('sha256', key).update(body).digest('hex');

type CheckpointHandlePayload = { schemaVersion: 1; id: string; projectHash: string };

function decodeHandle(handle: string, projectId: string, key: Buffer): CheckpointHandlePayload {
  const [body, signature, ...extra] = handle.split('.');
  if (!body || !signature || extra.length || !/^[a-f0-9]{64}$/u.test(signature)) throw Error('Guide evidence reduction checkpoint handle is malformed');
  const expected = Buffer.from(handleSignature(body, key), 'hex'), provided = Buffer.from(signature, 'hex');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw Error('Guide evidence reduction checkpoint handle authentication failed');
  let payload: CheckpointHandlePayload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as CheckpointHandlePayload; }
  catch { throw Error('Guide evidence reduction checkpoint handle payload is invalid'); }
  if (payload.schemaVersion !== 1 || !/^[a-f0-9]{32}$/u.test(payload.id) || payload.projectHash !== projectHash(projectId)) throw Error('Guide evidence reduction checkpoint handle binding is invalid');
  return payload;
}

export function guideEvidenceCheckpointStorageKey(projectId: string): string {
  return `agentflow:guide-evidence-reduction:${createHash('sha256').update(projectId).digest('hex').slice(0, 24)}`;
}

export async function loadOrCreateGuideEvidenceCheckpointKey(rootDir: string): Promise<Buffer> {
  const runtimeDir = path.join(rootDir, '.agent-workflow', 'runtime');
  const target = path.join(runtimeDir, keyFileName);
  await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  try {
    const handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(`${randomBytes(32).toString('base64url')}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Guide evidence checkpoint signing key must be a regular local file');
  if ((stat.mode & 0o077) !== 0) throw Error('Guide evidence checkpoint signing key permissions must be owner-only');
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    let encoded: string;
    try { encoded = (await handle.readFile('utf8')).trim(); } finally { await handle.close(); }
    const key = Buffer.from(encoded, 'base64url');
    if (key.length === 32 && key.toString('base64url') === encoded) return key;
    if (attempt < 24) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error('Guide evidence checkpoint signing key is invalid');
}

export async function persistGuideEvidenceReductionCheckpoint(input: { rootDir: string; projectId: string; checkpoint: string; expiresAt: string; signingKey: Buffer }): Promise<string> {
  const expiresAt = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt - Date.now() > 3_600_000 || input.checkpoint.length > 2_000_000) throw Error('Guide evidence reduction checkpoint persistence contract is invalid');
  const directory = path.join(input.rootDir, '.agent-workflow', 'runtime', checkpointDirectoryName);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const payload: CheckpointHandlePayload = { schemaVersion: 1, id: randomBytes(16).toString('hex'), projectHash: projectHash(input.projectId) };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url'), handle = `${body}.${handleSignature(body, input.signingKey)}`;
  const file = path.join(directory, `${payload.id}.json`), writer = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await writer.writeFile(`${JSON.stringify({ schemaVersion: 1, projectHash: payload.projectHash, expiresAt: input.expiresAt, checkpoint: input.checkpoint })}\n`, 'utf8'); await writer.sync(); }
  finally { await writer.close(); }
  return handle;
}

export async function readGuideEvidenceReductionCheckpoint(input: { rootDir: string; projectId: string; handle: string; signingKey: Buffer; now?: Date }): Promise<string> {
  const payload = decodeHandle(input.handle, input.projectId, input.signingKey), file = path.join(input.rootDir, '.agent-workflow', 'runtime', checkpointDirectoryName, `${payload.id}.json`);
  let reader;
  try { reader = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw Error('Guide evidence reduction checkpoint handle is unavailable'); throw error; }
  let parsed: { schemaVersion?: unknown; projectHash?: unknown; expiresAt?: unknown; checkpoint?: unknown };
  try { parsed = JSON.parse(await reader.readFile('utf8')) as typeof parsed; }
  catch { throw Error('Guide evidence reduction checkpoint file is invalid'); }
  finally { await reader.close(); }
  const expiresAt = typeof parsed.expiresAt === 'string' ? Date.parse(parsed.expiresAt) : Number.NaN;
  if (parsed.schemaVersion !== 1 || parsed.projectHash !== payload.projectHash || typeof parsed.checkpoint !== 'string' || parsed.checkpoint.length > 2_000_000 || !Number.isFinite(expiresAt)) throw Error('Guide evidence reduction checkpoint file binding is invalid');
  if (expiresAt <= (input.now ?? new Date()).getTime()) { await fs.unlink(file).catch(() => {}); throw Error('Guide evidence reduction checkpoint expired'); }
  return parsed.checkpoint;
}

export async function discardGuideEvidenceReductionCheckpoint(input: { rootDir: string; projectId: string; handle: string; signingKey: Buffer }): Promise<void> {
  const payload = decodeHandle(input.handle, input.projectId, input.signingKey), file = path.join(input.rootDir, '.agent-workflow', 'runtime', checkpointDirectoryName, `${payload.id}.json`);
  await fs.unlink(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
}
