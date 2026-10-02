import type { Command } from "commander";
import type { CliContext } from "../lib/context.js";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const LABEL = "com.agent-workflow.evaluation-daemon";

function plistPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function agentflowDir(rootDir: string): string {
  return path.join(rootDir, ".agent-workflow");
}

function plistXml(opts: {
  nodePath: string;
  repoRoot: string;
  hour: number;
  minute: number;
  logPath: string;
}): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(opts.nodePath)}</string>
    <string>${esc(path.join(opts.repoRoot, "node_modules", "tsx", "dist", "cli.mjs"))}</string>
    <string>${esc(path.join(opts.repoRoot, "scripts", "evaluation-daemon.ts"))}</string>
    <string>--tick</string>
    <string>--repo</string>
    <string>${esc(opts.repoRoot)}</string>
  </array>
  <key>WorkingDirectory</key><string>${esc(opts.repoRoot)}</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>${opts.hour}</integer>
    <key>Minute</key><integer>${opts.minute}</integer>
  </dict>
  <key>StandardOutPath</key><string>${esc(opts.logPath)}</string>
  <key>StandardErrorPath</key><string>${esc(opts.logPath)}</string>
</dict>
</plist>
`;
}

async function readConfigValue(rootDir: string, key: string, fallback: number): Promise<number> {
  try {
    const raw = await fs.readFile(path.join(agentflowDir(rootDir), "evaluation-daemon.yaml"), "utf8");
    const match = raw.match(new RegExp(`^${key}:\\s*(\\d+)`, "m"));
    return match ? parseInt(match[1], 10) : fallback;
  } catch {
    return fallback;
  }
}

async function launchctlList(label: string): Promise<boolean> {
  try {
    await execFileAsync("launchctl", ["list", label]);
    return true;
  } catch {
    return false;
  }
}

function nextRunDescription(hour: number, minute: number, now: Date): string {
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.toLocaleString();
}

export function registerEvaluationDaemonCommands(program: Command, ctx: CliContext): void {
  const cmd = program
    .command("evaluation-daemon")
    .description("Manage the automatic evaluation runner daemon");

  cmd
    .command("start")
    .description("Install and load the launchd plist for the evaluation daemon")
    .action(async () => {
      const rootDir = ctx.rootDir;
      const hour = await readConfigValue(rootDir, "hour", 2);
      const minute = await readConfigValue(rootDir, "minute", 0);
      const logPath = path.join(agentflowDir(rootDir), "evaluation-daemon.log");
      const xml = plistXml({
        nodePath: process.execPath,
        repoRoot: rootDir,
        hour,
        minute,
        logPath,
      });
      const dest = plistPath();
      await fs.mkdir(path.dirname(dest), { recursive: true });
      // Unload any previous copy first so the new schedule takes effect.
      try {
        await execFileAsync("launchctl", ["unload", dest]);
      } catch {
        // not previously loaded
      }
      await fs.writeFile(dest, xml, "utf8");
      await execFileAsync("launchctl", ["load", dest]);
      console.log(`Installed ${dest}`);
      console.log(`Schedule: daily at ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} local`);
      console.log(`Logs: ${logPath}`);
    });

  cmd
    .command("stop")
    .description("Unload and remove the evaluation daemon launchd plist")
    .action(async () => {
      const dest = plistPath();
      try {
        await execFileAsync("launchctl", ["unload", dest]);
        console.log(`Unloaded ${LABEL}`);
      } catch (err) {
        console.log(`Not loaded (${err instanceof Error ? err.message.split("\n")[0] : "unknown"}).`);
      }
      try {
        await fs.unlink(dest);
        console.log(`Removed ${dest}`);
      } catch {
        console.log("No plist file to remove.");
      }
    });

  cmd
    .command("status")
    .description("Show evaluation daemon config, last run, and next scheduled run")
    .option("--json", "output JSON")
    .action(async (options: { json?: boolean }) => {
      const rootDir = ctx.rootDir;
      const dir = agentflowDir(rootDir);
      const hour = await readConfigValue(rootDir, "hour", 2);
      const minute = await readConfigValue(rootDir, "minute", 0);
      const intervalHours = await readConfigValue(rootDir, "interval_hours", 24);
      const maxConcurrent = await readConfigValue(rootDir, "max_concurrent", 1);
      const plistInstalled = await fs
        .stat(plistPath())
        .then(() => true)
        .catch(() => false);
      const loaded = await launchctlList(LABEL);
      let state: Record<string, unknown> | null = null;
      try {
        state = JSON.parse(await fs.readFile(path.join(dir, "evaluation-daemon-state.json"), "utf8"));
      } catch {
        state = null;
      }
      let lock: Record<string, unknown> | null = null;
      try {
        lock = JSON.parse(await fs.readFile(path.join(dir, "evaluation-daemon.lock"), "utf8"));
      } catch {
        lock = null;
      }
      const status = {
        label: LABEL,
        plistInstalled,
        loaded,
        schedule: `daily at ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} local`,
        nextRun: nextRunDescription(hour, minute, new Date()),
        intervalHours,
        maxConcurrent,
        runningNow: lock !== null,
        lastTick: (state?.lastTick as string | undefined) ?? null,
        lastOutcomes: state?.outcomes ?? null,
      };
      if (options.json) {
        console.log(JSON.stringify(status, null, 2));
        return;
      }
      console.log(`Evaluation daemon: ${LABEL}`);
      console.log(`  plist: ${plistInstalled ? "installed" : "not installed"} / ${loaded ? "loaded" : "not loaded"}`);
      console.log(`  schedule: ${status.schedule} (next: ${status.nextRun})`);
      console.log(`  interval_hours: ${intervalHours}, max_concurrent: ${maxConcurrent}`);
      console.log(`  running now: ${status.runningNow ? "yes" : "no"}`);
      console.log(`  last tick: ${status.lastTick ?? "never"}`);
      const outcomes = status.lastOutcomes as Array<{ suite: string; ok: boolean }> | null;
      if (outcomes?.length) {
        for (const o of outcomes) console.log(`    - ${o.suite}: ${o.ok ? "ok" : "FAILED"}`);
      }
    });
}
