#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const label = process.env.AGENTFLOW_LAUNCHD_LABEL || "app.makealeft.agent-workflow";
const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
const plistPath = path.join(launchAgentsDir, `${label}.plist`);
const logDir = path.join(rootDir, ".agent-workflow", "runtime", "launchd");
const nodePath = process.execPath;
const env = buildLaunchdEnvironment();

await fs.mkdir(launchAgentsDir, { recursive: true });
await fs.mkdir(logDir, { recursive: true });
await fs.writeFile(plistPath, plist(label, nodePath, rootDir, logDir, env), "utf8");
await launchctl(["bootout", `gui/${process.getuid()}`, plistPath], true);
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
    "DATABASE_URL",
    "REDIS_URL",
    "OBJECT_STORAGE_ENDPOINT",
    "OBJECT_STORAGE_BUCKET",
    "OBJECT_STORAGE_ACCESS_KEY",
    "OBJECT_STORAGE_SECRET_KEY",
    "DEFAULT_MODEL_PROVIDER",
    "OPENAI_MODEL",
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
    "AGENTFLOW_DASHBOARD_PORT",
    "AGENTFLOW_WORKER_POOL_PROFILE",
    "AGENTFLOW_WORKER_LIMIT",
    "AGENTFLOW_WORKER_CONCURRENCY",
    "AGENTFLOW_WORKER_INTERVAL_MS"
  ];
  const values = {};
  for (const key of keys) {
    if (process.env[key]) values[key] = process.env[key];
  }
  values.PATH = values.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  values.HOME = values.HOME || os.homedir();
  return values;
}

function plist(serviceLabel, executable, cwd, logs, environment) {
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
    <string>${escapeXml(executable)}</string>
    <string>${escapeXml(path.join(cwd, "scripts", "dev-agentflow.mjs"))}</string>
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
