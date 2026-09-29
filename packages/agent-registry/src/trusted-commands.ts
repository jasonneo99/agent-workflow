import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

const trustedCommandFileEnv = "AGENTFLOW_TRUSTED_COMMANDS_FILE";

export type TrustedCommandFileOptions = {
  filePath?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

export function normalizeTrustedCommandPattern(value: string): string {
  const pattern = value.trim().replace(/\s+/g, " ");
  if (!pattern) throw new Error("Trusted command pattern is required.");
  if (pattern.includes("\0") || /[\r\n]/.test(value)) {
    throw new Error("Trusted command patterns must be a single line.");
  }
  if (pattern.length > 500) throw new Error("Trusted command patterns must be 500 characters or fewer.");
  return pattern;
}

export function globalTrustedCommandsPath(options: TrustedCommandFileOptions = {}): string {
  const configured = options.filePath ?? options.env?.[trustedCommandFileEnv] ?? process.env[trustedCommandFileEnv];
  if (configured?.trim()) return path.resolve(configured.trim());
  return path.join(options.homeDir ?? os.homedir(), ".config", "agent-workflow", "trusted-commands.yaml");
}

export async function loadGlobalTrustedCommands(options: TrustedCommandFileOptions = {}): Promise<string[]> {
  const filePath = globalTrustedCommandsPath(options);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const parsed = YAML.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { commands?: unknown }).commands)) {
    throw new Error(`Invalid global trusted commands file: ${filePath}`);
  }
  return [...new Set((parsed as { commands: unknown[] }).commands.map((value) => {
    if (typeof value !== "string") throw new Error(`Invalid global trusted command in: ${filePath}`);
    return normalizeTrustedCommandPattern(value);
  }))];
}

async function writeGlobalTrustedCommands(commands: string[], options: TrustedCommandFileOptions = {}): Promise<string> {
  const filePath = globalTrustedCommandsPath(options);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, YAML.stringify({ commands }), { encoding: "utf8", mode: 0o600 });
  await fs.rename(tempPath, filePath);
  await fs.chmod(filePath, 0o600);
  return filePath;
}

export async function addGlobalTrustedCommand(pattern: string, options: TrustedCommandFileOptions = {}): Promise<{ commands: string[]; filePath: string; created: boolean }> {
  const normalized = normalizeTrustedCommandPattern(pattern);
  const current = await loadGlobalTrustedCommands(options);
  const created = !current.includes(normalized);
  const commands = created ? [...current, normalized] : current;
  const filePath = await writeGlobalTrustedCommands(commands, options);
  return { commands, filePath, created };
}

export async function removeGlobalTrustedCommand(pattern: string, options: TrustedCommandFileOptions = {}): Promise<{ commands: string[]; filePath: string; removed: boolean }> {
  const normalized = normalizeTrustedCommandPattern(pattern);
  const current = await loadGlobalTrustedCommands(options);
  const commands = current.filter((command) => command !== normalized);
  const removed = commands.length !== current.length;
  const filePath = await writeGlobalTrustedCommands(commands, options);
  return { commands, filePath, removed };
}
