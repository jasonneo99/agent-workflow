import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectConfig } from "../../agent-registry/src/schemas.js";
import { assertFilePathAllowed, normalizeRelativePath, sha256 } from "./file-writer.js";
import { executeAllowedFileWrite, type FileWriteResult } from "./file-writer.js";

export interface FilePatchResult {
  relativePath: string;
  absolutePath: string;
  previousHash: string;
  nextHash: string;
  existed: true;
  patchBytes: number;
  bytesWritten: number;
  hunksApplied: number;
}

export interface RequestedFileMutation { path: string; content?: string | null; patch?: string | null; expectedHash?: string | null }

export function normalizeRequestedFileMutation(request: RequestedFileMutation): { isPatch: boolean; payload: string; expectedHash?: string; bytes: number; idempotencyPayload: string } | null {
  const isPatch = typeof request.patch === "string" && typeof request.expectedHash === "string";
  const payload = isPatch ? request.patch! : request.content;
  if (typeof payload !== "string") return null;
  return { isPatch, payload, expectedHash: isPatch ? request.expectedHash! : undefined, bytes: Buffer.byteLength(payload, "utf8"), idempotencyPayload: isPatch ? JSON.stringify({ patch: payload, expectedHash: request.expectedHash }) : payload };
}

export async function executeAllowedFileMutation(input: { request: RequestedFileMutation; payload: string; isPatch: boolean; expectedHash?: string; cwd: string; project: ProjectConfig }): Promise<FilePatchResult | FileWriteResult> {
  return input.isPatch
    ? executeAllowedFilePatch({ relativePath: input.request.path, patch: input.payload, expectedHash: input.expectedHash!, cwd: input.cwd, project: input.project })
    : executeAllowedFileWrite({ relativePath: input.request.path, content: input.payload, cwd: input.cwd, project: input.project });
}

export function summarizeFileMutation(result: FilePatchResult | FileWriteResult, isPatch: boolean): string {
  return isPatch
    ? `Patched \`${result.relativePath}\` with ${"hunksApplied" in result ? result.hunksApplied : 0} verified hunk(s). Verified the preimage hash before applying the patch.`
    : `Wrote ${result.bytesWritten} bytes to \`${result.relativePath}\`. ${result.existed ? "Updated existing file." : "Created new file."}`;
}

export async function executeAllowedFilePatch(input: {
  relativePath: string;
  patch: string;
  expectedHash: string;
  cwd: string;
  project: ProjectConfig;
}): Promise<FilePatchResult> {
  const relativePath = assertFilePatchAllowed(input.relativePath, input.patch, input.expectedHash, input.project);
  const projectRoot = path.resolve(input.cwd);
  const absolutePath = path.resolve(projectRoot, relativePath);
  if (!absolutePath.startsWith(`${projectRoot}${path.sep}`)) throw new Error("File patch rejected: path escapes the project root.");

  let previous: Buffer;
  try {
    previous = await readFile(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`File patch rejected: target does not exist: ${relativePath}`);
    throw error;
  }
  const previousHash = sha256(previous);
  if (previousHash !== input.expectedHash.toLowerCase()) {
    throw new Error(`File patch rejected: stale preimage hash for ${relativePath}; expected ${input.expectedHash.toLowerCase()}, found ${previousHash}.`);
  }

  const { content, hunksApplied } = applyUnifiedPatch(previous.toString("utf8"), input.patch);
  const next = Buffer.from(content, "utf8");
  await writeFile(absolutePath, next);
  return {
    relativePath,
    absolutePath,
    previousHash,
    nextHash: sha256(next),
    existed: true,
    patchBytes: Buffer.byteLength(input.patch, "utf8"),
    bytesWritten: next.byteLength,
    hunksApplied
  };
}

export function assertFilePatchAllowed(relativePathInput: string, patch: string, expectedHash: string, project: ProjectConfig): string {
  const relativePath = assertFilePathAllowed(normalizeRelativePath(relativePathInput), project);
  const patchBytes = Buffer.byteLength(patch, "utf8");
  if (!patch.trim()) throw new Error("File patch rejected: patch is empty.");
  if (patchBytes > project.actions.max_write_bytes) {
    throw new Error(`File patch rejected: patch is ${patchBytes} bytes, max is ${project.actions.max_write_bytes}.`);
  }
  if (!/^[a-f0-9]{64}$/u.test(expectedHash.toLowerCase())) throw new Error("File patch rejected: expectedHash must be a SHA-256 hex digest.");
  return relativePath;
}

export function applyUnifiedPatch(source: string, patch: string): { content: string; hunksApplied: number } {
  const sourceHasFinalNewline = source.endsWith("\n");
  const sourceLines = source.split("\n");
  if (sourceHasFinalNewline) sourceLines.pop();
  const patchLines = patch.replace(/\r\n/gu, "\n").split("\n");
  const output: string[] = [];
  let sourceCursor = 0;
  let patchCursor = 0;
  let hunksApplied = 0;

  while (patchCursor < patchLines.length) {
    const header = patchLines[patchCursor];
    if (!header.startsWith("@@")) {
      patchCursor += 1;
      continue;
    }
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/u.exec(header);
    if (!match) throw new Error(`File patch rejected: invalid hunk header: ${header}`);
    const oldStart = Number(match[1]) - 1;
    if (oldStart < sourceCursor || oldStart > sourceLines.length) throw new Error(`File patch rejected: hunk starts outside the target at old line ${match[1]}.`);
    output.push(...sourceLines.slice(sourceCursor, oldStart));
    sourceCursor = oldStart;
    patchCursor += 1;
    let removed = 0;
    let added = 0;
    while (patchCursor < patchLines.length && !patchLines[patchCursor].startsWith("@@")) {
      const line = patchLines[patchCursor];
      if (line === "\\ No newline at end of file") { patchCursor += 1; continue; }
      if (!line.length && patchCursor === patchLines.length - 1) { patchCursor += 1; break; }
      const marker = line[0];
      const text = line.slice(1);
      if (marker === " ") {
        if (sourceLines[sourceCursor] !== text) throw new Error(`File patch rejected: context mismatch at old line ${sourceCursor + 1}.`);
        output.push(text); sourceCursor += 1; removed += 1; added += 1;
      } else if (marker === "-") {
        if (sourceLines[sourceCursor] !== text) throw new Error(`File patch rejected: removal mismatch at old line ${sourceCursor + 1}.`);
        sourceCursor += 1; removed += 1;
      } else if (marker === "+") {
        output.push(text); added += 1;
      } else {
        throw new Error(`File patch rejected: unsupported hunk line: ${line}`);
      }
      patchCursor += 1;
    }
    const expectedRemoved = Number(match[2] ?? 1);
    const expectedAdded = Number(match[4] ?? 1);
    if (removed !== expectedRemoved || added !== expectedAdded) {
      throw new Error(`File patch rejected: hunk count mismatch; expected -${expectedRemoved}/+${expectedAdded}, received -${removed}/+${added}.`);
    }
    hunksApplied += 1;
  }
  if (!hunksApplied) throw new Error("File patch rejected: no unified-diff hunks were found.");
  output.push(...sourceLines.slice(sourceCursor));
  return { content: `${output.join("\n")}${sourceHasFinalNewline ? "\n" : ""}`, hunksApplied };
}
