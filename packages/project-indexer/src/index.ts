import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { ProjectConfig } from "../../agent-registry/src/schemas.js";
import type { ModelProvider } from "../../model-providers/src/index.js";

export interface IndexedProjectFile {
  sourceUri: string;
  contentHash: string;
  tokenEstimate: number;
  summary: string;
  metadata: Record<string, unknown>;
}

export interface ExistingProjectFileSummary {
  sourceUri: string;
  contentHash: string;
  tokenEstimate: number;
  summary: string;
}

export interface IndexProjectFilesResult {
  files: IndexedProjectFile[];
  refined: number;
  reused: number;
}

const defaultTextExtensions = new Set([
  ".cjs",
  ".css",
  ".csv",
  ".env",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".sql",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml"
]);

export async function indexProjectFiles(input: {
  projectDir: string;
  project: ProjectConfig;
  maxFiles?: number;
  maxBytesPerFile?: number;
  refineProvider?: ModelProvider;
  existingSummaries?: ExistingProjectFileSummary[];
  forceRefine?: boolean;
}): Promise<IndexProjectFilesResult> {
  const include = input.project.context.include.length ? input.project.context.include : ["AGENTS.md", ".agent-workflow/**"];
  const exclude = input.project.context.exclude;
  const maxFiles = input.maxFiles ?? 200;
  const maxBytesPerFile = input.maxBytesPerFile ?? 160_000;

  const files = await fg(include, {
    cwd: input.projectDir,
    absolute: true,
    dot: true,
    ignore: exclude,
    onlyFiles: true,
    unique: true
  });

  const indexed: IndexedProjectFile[] = [];
  let refined = 0;
  let reused = 0;
  const existingByPath = new Map((input.existingSummaries ?? []).map((summary) => [summary.sourceUri, summary]));

  for (const filePath of files.sort()) {
    if (indexed.length >= maxFiles) {
      break;
    }

    const relativePath = path.relative(input.projectDir, filePath);
    if (!isLikelyTextFile(filePath)) {
      continue;
    }

    const stat = await fs.stat(filePath);
    if (stat.size > maxBytesPerFile) {
      indexed.push({
        sourceUri: relativePath,
        contentHash: "skipped-large-file",
        tokenEstimate: 0,
        summary: `Skipped large file (${stat.size} bytes).`,
        metadata: {
          bytes: stat.size,
          skipped: true,
          reason: "file exceeds maxBytesPerFile"
        }
      });
      continue;
    }

    const content = await fs.readFile(filePath, "utf8");
    const contentHash = sha256(content);
    const deterministicSummary = summarizeText(relativePath, content);
    const existing = existingByPath.get(relativePath);

    if (existing?.contentHash === contentHash && existing.summary && input.refineProvider && !input.forceRefine) {
      reused += 1;
      indexed.push({
        sourceUri: relativePath,
        contentHash,
        tokenEstimate: estimateTokens(content),
        summary: existing.summary,
        metadata: {
          bytes: stat.size,
          extension: path.extname(filePath),
          reused: true
        }
      });
      continue;
    }

    let summary = deterministicSummary;
    const metadata: Record<string, unknown> = {
      bytes: stat.size,
      extension: path.extname(filePath)
    };

    if (input.refineProvider?.summarizeFile) {
      const output = await input.refineProvider.summarizeFile({
        sourceUri: relativePath,
        content,
        deterministicSummary
      });
      refined += 1;
      summary = output.summary;
      metadata.refined = true;
      metadata.refinement = output.artifact;
    }

    indexed.push({
      sourceUri: relativePath,
      contentHash,
      tokenEstimate: estimateTokens(content),
      summary,
      metadata
    });
  }

  return { files: indexed, refined, reused };
}

export function summarizeText(relativePath: string, content: string): string {
  const lines = content.split(/\r?\n/);
  const nonEmpty = lines.map((line) => line.trim()).filter(Boolean);
  const headings = nonEmpty.filter((line) => line.startsWith("#")).slice(0, 8);
  const imports = nonEmpty.filter((line) => /^(import|export|const|class|interface|type|function)\b/.test(line)).slice(0, 10);
  const firstLines = nonEmpty.slice(0, 8);
  const parts = [
    `File: ${relativePath}`,
    `Approx tokens: ${estimateTokens(content)}`,
    headings.length ? `Headings: ${headings.join(" | ")}` : "",
    imports.length ? `Symbols/imports: ${imports.join(" | ")}` : "",
    `Preview: ${firstLines.join(" ")}`
  ].filter(Boolean);

  return truncate(parts.join("\n"), 1200);
}

export function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

function isLikelyTextFile(filePath: string): boolean {
  const extension = path.extname(filePath);
  if (!extension) {
    return path.basename(filePath) === "AGENTS.md";
  }
  return defaultTextExtensions.has(extension);
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}\n...[truncated ${value.length - maxLength} chars]`;
}
