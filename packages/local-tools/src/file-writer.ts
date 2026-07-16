import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ProjectConfig } from "../../agent-registry/src/schemas.js";

export interface FileWriteResult {
  relativePath: string;
  absolutePath: string;
  existed: boolean;
  previousHash: string | null;
  nextHash: string;
  bytesWritten: number;
}

export async function executeAllowedFileWrite(input: {
  relativePath: string;
  content: string;
  cwd: string;
  project: ProjectConfig;
}): Promise<FileWriteResult> {
  const relativePath = normalizeRelativePath(input.relativePath);
  assertFileWriteAllowed(relativePath, input.content, input.project);

  const absolutePath = path.resolve(input.cwd, relativePath);
  const projectRoot = path.resolve(input.cwd);
  if (!absolutePath.startsWith(`${projectRoot}${path.sep}`)) {
    throw new Error("File write rejected: path escapes the project root.");
  }

  let previousContent: Buffer | null = null;
  try {
    previousContent = await readFile(absolutePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  const contentBuffer = Buffer.from(input.content, "utf8");
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contentBuffer);

  return {
    relativePath,
    absolutePath,
    existed: previousContent !== null,
    previousHash: previousContent ? sha256(previousContent) : null,
    nextHash: sha256(contentBuffer),
    bytesWritten: contentBuffer.byteLength
  };
}

export function assertFileWriteAllowed(relativePathInput: string, content: string, project: ProjectConfig): void {
  const relativePath = normalizeRelativePath(relativePathInput);
  const bytes = Buffer.byteLength(content, "utf8");

  if (bytes > project.actions.max_write_bytes) {
    throw new Error(`File write rejected: content is ${bytes} bytes, max is ${project.actions.max_write_bytes}.`);
  }

  for (const pattern of project.actions.blocked_write_paths) {
    if (matchesGlob(relativePath, pattern)) {
      throw new Error(`File write rejected by blocked path pattern: ${pattern}`);
    }
  }

  const allowed = project.actions.allowed_write_paths.some((pattern) => matchesGlob(relativePath, pattern));
  if (!allowed) {
    throw new Error(`File write is not allowed by project policy: ${relativePath}`);
  }
}

function normalizeRelativePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!normalized) {
    throw new Error("File write rejected: path is empty.");
  }
  if (path.posix.isAbsolute(normalized)) {
    throw new Error("File write rejected: absolute paths are not allowed.");
  }
  if (normalized.split("/").includes("..")) {
    throw new Error("File write rejected: parent path segments are not allowed.");
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

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
