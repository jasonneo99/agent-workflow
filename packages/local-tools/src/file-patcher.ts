import { readFile, realpath, lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectConfig } from "../../agent-registry/src/schemas.js";
import { assertFilePathAllowed, normalizeRelativePath, sha256 } from "./file-writer.js";
import { executeAllowedFileWrite, type FileWriteResult } from "./file-writer.js";

export interface FilePatchResult {
  relativePath: string;
  absolutePath: string;
  projectRoot: string;
  outcome: "applied" | "already_satisfied";
  expectedHash: string;
  patchHash: string;
  previousHash: string;
  nextHash: string;
  existed: true;
  patchBytes: number;
  bytesWritten: number;
  hunksApplied: number;
}

export interface RequestedFileMutation { path: string; content?: string | null; patch?: string | null; expectedHash?: string | null }

export function normalizeRequestedFileMutation(request: RequestedFileMutation): { isPatch: boolean; payload: string; expectedHash?: string; bytes: number; idempotencyPayload: string } | null {
  const hasPatchFields = typeof request.patch === "string" || typeof request.expectedHash === "string";
  if (hasPatchFields && (typeof request.patch !== "string" || typeof request.expectedHash !== "string" || request.content != null)) return null;
  if (!hasPatchFields && (typeof request.content !== "string" || request.patch != null || request.expectedHash != null)) return null;
  const isPatch = hasPatchFields;
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
    ? "outcome" in result && result.outcome === "already_satisfied"
      ? `Patch for \`${result.relativePath}\` was already satisfied; reconstructed and verified the approved preimage without writing.`
      : `Patched \`${result.relativePath}\` with ${"hunksApplied" in result ? result.hunksApplied : 0} verified hunk(s). Verified the preimage hash before applying the patch.`
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
  const projectRoot = await realpath(path.resolve(input.cwd));
  const unresolvedPath = path.resolve(projectRoot, relativePath);
  const absolutePath = await realpath(unresolvedPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(`File patch rejected: target does not exist: ${relativePath}`);
    throw error;
  });
  if (!absolutePath.startsWith(`${projectRoot}${path.sep}`)) throw new Error("File patch rejected: path escapes the project root.");
  if (absolutePath !== unresolvedPath) throw new Error('File patch rejected: exact scoped path must not be a symlink alias.');
  const identity = await lstat(absolutePath);
  if (!identity.isFile() || identity.nlink !== 1) throw new Error('File patch rejected: target must be an unshared regular file.');

  const previous = await readFile(absolutePath);
  if (previous.includes(0) || !Buffer.from(previous.toString('utf8'),'utf8').equals(previous)) throw new Error('File patch rejected: target must be valid UTF-8 text.');
  const previousHash = sha256(previous);
  const expectedHash = input.expectedHash.toLowerCase();
  const patchHash = sha256(Buffer.from(input.patch, "utf8"));
  if (previousHash !== input.expectedHash.toLowerCase()) {
    try {
      const restored = applyUnifiedPatch(previous.toString("utf8"), reverseUnifiedPatch(input.patch));
      if (sha256(Buffer.from(restored.content, "utf8")) === expectedHash) {
        return {
          relativePath, absolutePath, projectRoot, outcome: "already_satisfied",
          expectedHash, patchHash, previousHash, nextHash: previousHash,
          existed: true, patchBytes: Buffer.byteLength(input.patch, "utf8"),
          bytesWritten: previous.byteLength, hunksApplied: restored.hunksApplied
        };
      }
    } catch {
      // A malformed, mismatched, or unrelated postimage remains stale below.
    }
    throw new Error(`File patch rejected: stale preimage hash for ${relativePath}; expected ${expectedHash}, found ${previousHash}.`);
  }

  const { content, hunksApplied } = applyUnifiedPatch(previous.toString("utf8"), input.patch);
  const next = Buffer.from(content, "utf8");
  const live = await lstat(absolutePath);
  if (await realpath(unresolvedPath) !== absolutePath || !live.isFile() || live.nlink !== 1 || live.ino !== identity.ino || live.dev !== identity.dev
    || sha256(await readFile(absolutePath)) !== previousHash) throw new Error('File patch rejected: preimage changed before write.');
  await writeFile(absolutePath, next);
  return {
    relativePath,
    absolutePath,
    projectRoot,
    outcome: "applied",
    expectedHash,
    patchHash,
    previousHash,
    nextHash: sha256(next),
    existed: true,
    patchBytes: Buffer.byteLength(input.patch, "utf8"),
    bytesWritten: next.byteLength,
    hunksApplied
  };
}

/** A full replacement denial is not permission to widen paths or size limits.
 * Return a recovery instruction only when this exact path is already allowed. */
export function oversizedReplacementPatchHint(relativePath:string,content:string,project:ProjectConfig):string|null{
  if(Buffer.byteLength(content,'utf8')<=project.actions.max_write_bytes)return null;
  try{assertFilePathAllowed(relativePath,project);}catch{return null;}
  return `Do not request a policy change or repeat the full replacement. Read a bounded exact range such as ${relativePath}#L1-L100 to obtain the full-file SHA-256 and exact hunk context. Return requestedFileWrites with the same path, content:null, a compact unified-diff patch, and expectedHash equal to that SHA-256. Patch bytes remain limited to ${project.actions.max_write_bytes}; exact scope, approvals, work intent, receipts and acceptance gates still apply.`;
}

/** Build the exact inverse used only to prove that a target is already the approved postimage. */
export function reverseUnifiedPatch(patch: string): string {
  return patch.replace(/\r\n/gu, "\n").split("\n").map((line) => {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/u.exec(line);
    if (header) {
      const oldCount = header[2] === undefined ? "" : `,${header[2]}`;
      const newCount = header[4] === undefined ? "" : `,${header[4]}`;
      return `@@ -${header[3]}${newCount} +${header[1]}${oldCount} @@${header[5]}`;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) return `-${line.slice(1)}`;
    if (line.startsWith("-") && !line.startsWith("---")) return `+${line.slice(1)}`;
    return line;
  }).join("\n");
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
    // Empty ranges name the line before the insertion (0 means before line 1).
    const oldStart = Number(match[1]) - (Number(match[2] ?? 1) === 0 ? 0 : 1);
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
        if (sourceLines[sourceCursor] !== text) throw new Error(`File patch rejected: context mismatch at old line ${sourceCursor + 1}; patch expected ${JSON.stringify(text.slice(0, 240))}; file contains ${JSON.stringify(sourceLines[sourceCursor]?.slice(0, 240) ?? "<end of file>")}. Regenerate from the exact current preimage; do not relax matching.`);
        output.push(text); sourceCursor += 1; removed += 1; added += 1;
      } else if (marker === "-") {
        if (sourceLines[sourceCursor] !== text) throw new Error(`File patch rejected: removal mismatch at old line ${sourceCursor + 1}; patch expected ${JSON.stringify(text.slice(0, 240))}; file contains ${JSON.stringify(sourceLines[sourceCursor]?.slice(0, 240) ?? "<end of file>")}. Regenerate from the exact current preimage; do not relax matching.`);
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
