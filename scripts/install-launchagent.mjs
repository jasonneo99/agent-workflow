#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(rootDir, ".env"), quiet: true, override: true });
dotenv.config({ path: path.join(rootDir, ".agent-workflow", "runtime.env"), quiet: true, override: true });
const label = process.env.AGENTFLOW_LAUNCHD_LABEL || "app.makealeft.agent-workflow";
const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
const plistPath = path.join(launchAgentsDir, `${label}.plist`);
const logDir = path.join(rootDir, ".agent-workflow", "runtime", "launchd");
const env = buildLaunchdEnvironment();

await fs.mkdir(launchAgentsDir, { recursive: true });
await fs.mkdir(logDir, { recursive: true });
await fs.writeFile(plistPath, plist(label, rootDir, logDir, env), "utf8");
await launchctl(["bootout", `gui/${process.getuid()}`, plistPath], true);
await launchctl(["enable", `gui/${process.getuid()}/${label}`], true);
await launchctl(["bootstrap", `gui/${process.getuid()}`, plistPath], false);
await launchctl(["enable", `gui/${process.getuid()}/${label}`], true);
await launchctl(["kickstart", "-k", `gui/${process.getuid()}/${label}`], true);

console.log(`Installed Agent Workflow LaunchAgent: ${plistPath}`);
console.log(`Label: ${label}`);
console.log(`Dashboard: http://127.0.0.1:${env.AGENTFLOW_DASHBOARD_PORT || "17888"}`);
console.log(`Logs: ${logDir}`);

function buildLaunchdEnvironment() {
  const keys = [
    "PATH",
    "HOME",
    "USER",
    "SHELL",
    "DEFAULT_MODEL_PROVIDER",
    "OPENAI_MODEL",
    "LOCAL_MODEL_BASE_URL",
    "LOCAL_MODEL_NAME",
    "LOCAL_MODEL_FAST",
    "LOCAL_MODEL_STANDARD",
    "LOCAL_MODEL_REASONING",
    "AGENTFLOW_AUTO_PROVIDERS",
    "BYO_MODEL_BASE_URL",
    "BYO_MODEL_NAME",
    "AWS_PROFILE",
    "AWS_REGION",
    "AGENTFLOW_PROJECT",
    "AGENTFLOW_LEARNING_PROJECT",
    "AGENTFLOW_LEARNING_SCOPE",
    "AGENTFLOW_LEARNING_ALL_PROJECTS",
    "AGENTFLOW_LEARNING_DAEMON",
    "AGENTFLOW_LEARNING_MODE",
    "AGENTFLOW_LEARNING_INTERVAL_MS",
    "AGENTFLOW_LEARNING_LIMIT",
    "AGENTFLOW_LEARNING_AUTONOMOUS_MAX_RISK",
    "AGENTFLOW_LEARNING_WORKFLOW_SHAPE_AUTO_UPDATE",
    "AGENTFLOW_APPROVAL_AUTOPILOT",
    "AGENTFLOW_APPROVAL_AUTOPILOT_MAX_RISK",
    "AGENTFLOW_DASHBOARD_PORT",
    "AGENTFLOW_START_LOCAL_STORAGE",
    "AGENTFLOW_WORKER_POOL_PROFILE",
    "AGENTFLOW_WORKER_LIMIT",
    "AGENTFLOW_WORKER_CONCURRENCY",
    "AGENTFLOW_WORKER_INTERVAL_MS"
  ];
  const values = {};
  for (const key of keys) {
    if (process.env[key] && !isSensitiveEnvironmentKey(key)) values[key] = process.env[key];
  }
  values.PATH = withDeveloperToolPath(values.PATH);
  values.HOME = values.HOME || os.homedir();
  return values;
}

function withDeveloperToolPath(currentPath) {
  const prefixes = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const existing = String(currentPath || "").split(":").filter(Boolean);
  return [...prefixes, ...existing.filter((entry) => !prefixes.includes(entry))].join(":");
}

function isSensitiveEnvironmentKey(key) {
  return /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL|REDIS_URL|OBJECT_STORAGE_ACCESS_KEY|OBJECT_STORAGE_SECRET_KEY)/i.test(key);
}

function plist(serviceLabel, cwd, logs, environment) {
  const envXml = Object.entries(environment)
    .map(([key, value]) => `      <key>${escapeXml(key)}</key>\n      <string>${escapeXml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(serviceLabel)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>${escapeXml(path.join(cwd, "scripts", "run-agent-workflow-supervisor.sh"))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(cwd)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(logs, "stdout.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(logs, "stderr.log"))}</string>
</dict>
</plist>
`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function launchctl(args, allowFailure) {
  return new Promise((resolve, reject) => {
    execFile("launchctl", args, (error) => {
      if (error && !allowFailure) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
