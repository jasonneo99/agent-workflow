import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const runFile = promisify(execFile);

export type RepositoryMaintenanceFinding = { kind: "hygiene" | "security"; severity: "info" | "warning" | "error"; file: string; line: number; summary: string; autoFixEligible: boolean };
export type RepositoryMaintenanceReport = { kind: "agentflow_repository_maintenance_report"; generatedAt: string; projectRootHash: string; filesScanned: number; findings: RepositoryMaintenanceFinding[]; summary: { hygiene: number; security: number; autoFixEligible: number; errors: number } };

export async function scanRepositoryMaintenance(projectRoot: string): Promise<RepositoryMaintenanceReport> {
  const files = await fg(["apps/**/*.{ts,js,mjs}", "packages/**/*.{ts,js,mjs}", "scripts/**/*.{js,mjs,sh}", "infra/**/*.{yaml,yml,sql}"], { cwd: projectRoot, onlyFiles: true, ignore: ["**/dist/**", "**/node_modules/**", "**/*.test.ts"] });
  const findings: RepositoryMaintenanceFinding[] = [];
  const blocks = new Map<string, Array<{ file: string; line: number }>>();
  for (const file of files) {
    const content = await fs.readFile(path.join(projectRoot, file), "utf8");
    const lines = content.split(/\r?\n/u);
    if (lines.length > 5000) findings.push({ kind: "hygiene", severity: "warning", file, line: 1, summary: `${lines.length}-line source file raises duplication and ownership risk.`, autoFixEligible: false });
    for (const [index, line] of lines.entries()) {
      if (/AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}/u.test(line)) findings.push({ kind: "security", severity: "error", file, line: index + 1, summary: "Possible committed credential or private key material.", autoFixEligible: false });
      if (/(?:^|[=({;,]\s*)eval\s*\(|(?:^|[=({;,]\s*)new Function\s*\(/u.test(line)) findings.push({ kind: "security", severity: "warning", file, line: index + 1, summary: "Dynamic code execution requires security review.", autoFixEligible: false });
    }
    for (let index = 0; index <= lines.length - 10; index += 1) {
      const normalized = lines.slice(index, index + 10).map((line) => line.trim().replace(/\s+/gu, " ")).join("\n");
      if (normalized.length < 300 || normalized.includes("import ")) continue;
      const hash = createHash("sha256").update(normalized).digest("hex");
      blocks.set(hash, [...(blocks.get(hash) ?? []), { file, line: index + 1 }]);
    }
  }
  const duplicateRegions = new Set<string>();
  for (const matches of blocks.values()) {
    if (new Set(matches.map((item) => item.file)).size < 2) continue;
    const first = matches[0]!;
    const regionKey = matches.map((item) => item.file).sort().join("|");
    if (duplicateRegions.has(regionKey)) continue;
    duplicateRegions.add(regionKey);
    findings.push({ kind: "hygiene", severity: "warning", file: first.file, line: first.line, summary: `Duplicated block also appears at ${matches.slice(1, 4).map((item) => `${item.file}:${item.line}`).join(", ")}.`, autoFixEligible: false });
  }
  const unique = [...new Map(findings.map((item) => [`${item.kind}:${item.file}:${item.line}:${item.summary}`, item])).values()];
  return { kind: "agentflow_repository_maintenance_report", generatedAt: new Date().toISOString(), projectRootHash: createHash("sha256").update(path.resolve(projectRoot)).digest("hex"), filesScanned: files.length, findings: unique, summary: { hygiene: unique.filter((item) => item.kind === "hygiene").length, security: unique.filter((item) => item.kind === "security").length, autoFixEligible: unique.filter((item) => item.autoFixEligible).length, errors: unique.filter((item) => item.severity === "error").length } };
}

export async function writeRepositoryMaintenanceReceipt(projectRoot: string, report: RepositoryMaintenanceReport, applied: Array<{ file: string; beforeHash: string; afterHash: string; validation: string }> = [], commit: { hash: string; message: string } | null = null): Promise<string> {
  const directory = path.join(projectRoot, ".agent-workflow", "learning");
  await fs.mkdir(directory, { recursive: true });
  const target = path.join(directory, "repository-maintenance-receipt.json");
  await fs.writeFile(target, `${JSON.stringify({ ...report, applied, commit, visibility: { changedFiles: applied.map((item) => item.file), beforeAfterHashes: true, validationRecorded: true, commitRecorded: Boolean(commit) } }, null, 2)}\n`, "utf8");
  return target;
}

export async function commitRepositoryMaintenance(input: { projectRoot: string; files: string[]; message?: string; validation: string }): Promise<{ hash: string; message: string; applied: Array<{ file: string; beforeHash: string; afterHash: string; validation: string }> } | null> {
  const files = [...new Set(input.files)].filter(Boolean);
  if (!files.length) return null;
  const applied = [];
  for (const file of files) {
    const absolute = path.resolve(input.projectRoot, file);
    if (absolute !== input.projectRoot && !absolute.startsWith(`${path.resolve(input.projectRoot)}${path.sep}`)) throw new Error(`Maintenance commit path escapes project: ${file}`);
    let beforeHash = "new"; let afterHash = "deleted";
    try { beforeHash = createHash("sha256").update((await runFile("git", ["show", `HEAD:${file}`], { cwd: input.projectRoot })).stdout).digest("hex"); } catch { /* new file */ }
    try { afterHash = createHash("sha256").update(await fs.readFile(absolute)).digest("hex"); } catch { /* deleted file */ }
    applied.push({ file, beforeHash, afterHash, validation: input.validation });
  }
  await runFile("git", ["add", "--", ...files], { cwd: input.projectRoot });
  try { await runFile("git", ["diff", "--cached", "--quiet", "--", ...files], { cwd: input.projectRoot }); return null; } catch { /* staged changes exist */ }
  const message = input.message ?? "chore: apply visible repository maintenance";
  await runFile("git", ["commit", "-m", message, "--", ...files], { cwd: input.projectRoot });
  const hash = (await runFile("git", ["rev-parse", "--short=8", "HEAD"], { cwd: input.projectRoot })).stdout.trim();
  return { hash, message, applied };
}
