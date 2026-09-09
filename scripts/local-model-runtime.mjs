#!/usr/bin/env node
import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(rootDir, ".env"), quiet: true, override: true });
dotenv.config({ path: path.join(rootDir, ".agent-workflow", "runtime.env"), quiet: true, override: true });
const command = process.argv[2] ?? "status";
const json = process.argv.includes("--json");
const label = process.env.AGENTFLOW_LOCAL_MODEL_LAUNCHD_LABEL || "app.makealeft.agent-workflow.local-model";
const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
const plistPath = path.join(launchAgentsDir, `${label}.plist`);
const logDir = path.join(rootDir, ".agent-workflow", "runtime", "local-model");
const stdoutPath = path.join(logDir, "stdout.log");
const stderrPath = path.join(logDir, "stderr.log");
const endpoint = process.env.LOCAL_MODEL_BASE_URL || "http://127.0.0.1:11434/v1";

if (command === "install") await install();
else if (command === "uninstall") await uninstall();
else if (command === "status") await printStatus();
else throw new Error(`Unknown local model runtime command: ${command}`);

async function install() {
  if (process.platform !== "darwin") throw new Error("The durable local-model LaunchAgent is supported only on macOS.");
  const runtime = process.env.AGENTFLOW_LOCAL_MODEL_RUNTIME === "llama-server" ? "llama-server" : "ollama";
  const executable = runtime === "llama-server" ? await resolveLlamaServer() : await resolveExecutable("ollama");
  if (!executable) throw new Error(`${runtime} is not installed. Install Ollama first, then rerun npm run local-model:launchd:install.`);
  if (runtime === "llama-server" && !process.env.LOCAL_MODEL_FILE) throw new Error("LOCAL_MODEL_FILE is required for the llama-server runtime.");
  await fs.mkdir(launchAgentsDir, { recursive: true });
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(plistPath, plist(), "utf8");
  await launchctl(["bootout", `gui/${process.getuid()}`, plistPath], true);
  await launchctl(["enable", `gui/${process.getuid()}/${label}`], true);
  await launchctl(["bootstrap", `gui/${process.getuid()}`, plistPath], false);
  await launchctl(["kickstart", "-k", `gui/${process.getuid()}/${label}`], true);
  console.log(`Installed durable local model LaunchAgent: ${plistPath}`);
  console.log(`Runtime: ${executable}`);
  console.log(`Endpoint: ${safeUrl(endpoint)}`);
  console.log(`Logs: ${logDir}`);
}

async function uninstall() {
  await launchctl(["bootout", `gui/${process.getuid()}`, plistPath], true);
  await launchctl(["disable", `gui/${process.getuid()}/${label}`], true);
  await fs.rm(plistPath, { force: true });
  console.log(`Removed local model LaunchAgent: ${plistPath}`);
  console.log("Downloaded models were left in place.");
}

async function printStatus() {
  const runtime = process.env.AGENTFLOW_LOCAL_MODEL_RUNTIME === "llama-server" ? "llama-server" : "ollama";
  const executable = runtime === "llama-server" ? await resolveLlamaServer() : await resolveExecutable("ollama");
  const installed = Boolean(await fs.stat(plistPath).catch(() => null));
  const service = process.platform === "darwin" ? await launchctl(["print", `gui/${process.getuid()}/${label}`], true, true) : { stdout: "", exitCode: 1 };
  const health = await endpointHealth(endpoint);
  const report = {
    kind: "agentflow_local_model_runtime_status",
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    runtime: executable ? runtime : "missing",
    executable,
    label,
    plistPath,
    installed,
    serviceStatus: service.exitCode === 0 ? "running" : installed ? "installed" : "missing",
    pid: numberMatch(service.stdout, /\bpid = (\d+)/),
    runs: numberMatch(service.stdout, /\bruns = (\d+)/),
    endpoint: safeUrl(endpoint),
    endpointHealthy: health.ok,
    modelCount: health.modelCount,
    selectedModel: process.env.LOCAL_MODEL_NAME || "auto",
    stdoutPath,
    stderrPath,
    installCommand: "npm run local-model:launchd:install",
    uninstallCommand: "npm run local-model:launchd:uninstall",
    restartCommand: `launchctl kickstart -k gui/${process.getuid()}/${label}`,
    guidance: !executable
      ? "Install Ollama, then install the dedicated LaunchAgent."
      : !installed
        ? "Install the dedicated LaunchAgent so local inference survives login, crashes, and upgrades."
        : !health.ok
          ? "Inspect local-model logs and restart the dedicated LaunchAgent."
          : health.modelCount === 0
            ? "The runtime is healthy but has no models; review the generated installation plan before downloading one."
            : "Local runtime service and model catalog are healthy."
  };
  console.log(json ? JSON.stringify(report) : Object.entries(report).map(([key, value]) => `${key}: ${value}`).join("\n"));
}

function plist() {
  const runner = path.join(rootDir, "scripts", "run-local-model-runtime.sh");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${escapeXml(label)}</string>
  <key>ProgramArguments</key><array><string>/bin/zsh</string><string>${escapeXml(runner)}</string></array>
  <key>WorkingDirectory</key><string>${escapeXml(rootDir)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>${escapeXml(os.homedir())}</string>
    <key>LOCAL_MODEL_BASE_URL</key><string>${escapeXml(endpoint)}</string>
    ${process.env.LOCAL_MODEL_NAME ? `<key>LOCAL_MODEL_NAME</key><string>${escapeXml(process.env.LOCAL_MODEL_NAME)}</string>` : ""}
    ${process.env.LOCAL_MODEL_FAST ? `<key>LOCAL_MODEL_FAST</key><string>${escapeXml(process.env.LOCAL_MODEL_FAST)}</string>` : ""}
    ${process.env.LOCAL_MODEL_STANDARD ? `<key>LOCAL_MODEL_STANDARD</key><string>${escapeXml(process.env.LOCAL_MODEL_STANDARD)}</string>` : ""}
    ${process.env.LOCAL_MODEL_REASONING ? `<key>LOCAL_MODEL_REASONING</key><string>${escapeXml(process.env.LOCAL_MODEL_REASONING)}</string>` : ""}
    ${process.env.LOCAL_MODEL_CONTEXT_SIZE ? `<key>LOCAL_MODEL_CONTEXT_SIZE</key><string>${escapeXml(process.env.LOCAL_MODEL_CONTEXT_SIZE)}</string>` : ""}
    ${process.env.OLLAMA_LLM_LIBRARY ? `<key>OLLAMA_LLM_LIBRARY</key><string>${escapeXml(process.env.OLLAMA_LLM_LIBRARY)}</string>` : ""}
    ${process.env.AGENTFLOW_LOCAL_MODEL_RUNTIME ? `<key>AGENTFLOW_LOCAL_MODEL_RUNTIME</key><string>${escapeXml(process.env.AGENTFLOW_LOCAL_MODEL_RUNTIME)}</string>` : ""}
    ${process.env.LOCAL_MODEL_FILE ? `<key>LOCAL_MODEL_FILE</key><string>${escapeXml(process.env.LOCAL_MODEL_FILE)}</string>` : ""}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${escapeXml(stdoutPath)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(stderrPath)}</string>
</dict></plist>\n`;
}

async function endpointHealth(baseUrl) {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return { ok: false, modelCount: 0 };
    const payload = await response.json();
    return { ok: true, modelCount: Array.isArray(payload?.data) ? payload.data.length : 0 };
  } catch { return { ok: false, modelCount: 0 }; }
}

async function resolveExecutable(name) {
  for (const candidate of [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`]) {
    if (await fs.access(candidate, constants.X_OK).then(() => true).catch(() => false)) return candidate;
  }
  const result = await exec(name === "ollama" ? "/usr/bin/which" : "which", [name], true);
  return result.exitCode === 0 ? result.stdout.trim() || null : null;
}
async function resolveLlamaServer() {
  for (const candidate of ["/opt/homebrew/opt/ollama/libexec/lib/ollama/llama-server", "/usr/local/opt/ollama/libexec/lib/ollama/llama-server"]) {
    if (await fs.access(candidate, constants.X_OK).then(() => true).catch(() => false)) return candidate;
  }
  return null;
}

function launchctl(args, allowFailure, capture = false) { return exec("/bin/launchctl", args, allowFailure, capture); }
function exec(file, args, allowFailure = false, capture = true) {
  return new Promise((resolve, reject) => execFile(file, args, (error, stdout, stderr) => {
    if (error && !allowFailure) return reject(error);
    resolve({ stdout: capture ? stdout : "", stderr: capture ? stderr : "", exitCode: error && "code" in error && typeof error.code === "number" ? error.code : error ? 1 : 0 });
  }));
}
function numberMatch(value, pattern) { const parsed = Number.parseInt(value.match(pattern)?.[1] ?? "", 10); return Number.isFinite(parsed) ? parsed : null; }
function safeUrl(value) { try { const url = new URL(value); url.username = ""; url.password = ""; url.search = ""; return url.toString().replace(/\/$/, ""); } catch { return "invalid"; } }
function escapeXml(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }
