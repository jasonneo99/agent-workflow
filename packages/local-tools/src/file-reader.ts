import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ProjectConfig } from "../../agent-registry/src/schemas.js";

export interface FileReadResult {
  relativePath: string;
  absolutePath: string;
  content: string;
  bytesRead: number;
  truncated: boolean;
  sha256: string;
}

export async function executeAllowedFileRead(input: {
  relativePath: string;
  cwd: string;
  project: ProjectConfig;
}): Promise<FileReadResult> {
  const relativePath = normalizeRelativePath(input.relativePath);
  assertFileReadAllowed(relativePath, input.project);

  const absolutePath = path.resolve(input.cwd, relativePath);
  const projectRoot = path.resolve(input.cwd);
  if (!absolutePath.startsWith(`${projectRoot}${path.sep}`)) {
    throw new Error("File read rejected: path escapes the project root.");
  }

  const fileStat = await stat(absolutePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new Error(`File read failed: no such file: ${relativePath}`);
    }
    throw error;
  });
  if (!fileStat.isFile()) {
    throw new Error(`File read failed: not a regular file: ${relativePath}`);
  }

  const maxBytes = input.project.actions.max_read_bytes;
  const bytesToRead = Math.min(fileStat.size, maxBytes);
  const truncated = fileStat.size > maxBytes;

  const handle = await readFile(absolutePath);
  const slice = handle.subarray(0, bytesToRead);
  if (slice.includes(0)) {
    throw new Error(`File read failed: ${relativePath} appears to be a binary file.`);
  }
  const content = slice.toString("utf8");

  return {
    relativePath,
    absolutePath,
    content,
    bytesRead: slice.byteLength,
    truncated,
    sha256: createHash("sha256").update(handle).digest("hex")
  };
}

export function assertFileReadAllowed(relativePathInput: string, project: ProjectConfig): void {
  const relativePath = normalizeRelativePath(relativePathInput);

  for (const pattern of project.actions.blocked_read_paths) {
    if (matchesGlob(relativePath, pattern)) {
      throw new Error(`File read rejected by blocked path pattern: ${pattern}`);
    }
  }

  const allowed = project.actions.allowed_read_paths.some((pattern) => matchesGlob(relativePath, pattern));
  if (!allowed) {
    throw new Error(`File read is not allowed by project policy: ${relativePath}`);
  }
}

function normalizeRelativePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!normalized) {
    throw new Error("File read rejected: path is empty.");
  }
  if (path.posix.isAbsolute(normalized)) {
    throw new Error("File read rejected: absolute paths are not allowed.");
  }
  if (normalized.split("/").includes("..")) {
    throw new Error("File read rejected: parent path segments are not allowed.");
  }
  return normalized;
}

function matchesGlob(value: string, pattern: string): boolean {
  const normalizedPattern = pattern.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  const regex = globToRegExp(normalizedPattern);
  return regex.test(value);
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    const next = pattern[i + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      i += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += escapeRegExp(char);
    }
  }
  source += "$";
  return new RegExp(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
