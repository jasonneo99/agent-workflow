#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const rootDir = process.cwd();
const port = Number.parseInt(process.env.AGENTFLOW_SCREENSHOT_PORT ?? "17921", 10);
const width = Number.parseInt(process.env.AGENTFLOW_SCREENSHOT_WIDTH ?? "1440", 10);
const height = Number.parseInt(process.env.AGENTFLOW_SCREENSHOT_HEIGHT ?? "1500", 10);
const project = process.env.AGENTFLOW_SCREENSHOT_PROJECT ?? "templates/project";
const workflow = process.env.AGENTFLOW_SCREENSHOT_WORKFLOW ?? "build-feature";
const policyProfile = process.env.AGENTFLOW_SCREENSHOT_POLICY ?? "local";
const browserPath = await findBrowser();

if (!browserPath) {
  console.error("No Chrome-compatible browser found. Set AGENTFLOW_SCREENSHOT_BROWSER=/path/to/chrome and rerun.");
  process.exit(1);
}

const dashboard = spawn("npm", ["run", "dashboard", "--", "--port", String(port)], {
  cwd: rootDir,
  stdio: ["ignore", "pipe", "pipe"]
});

try {
  await waitForDashboard(port, dashboard);
  const base = `http://127.0.0.1:${port}/workflow-graph?workflow=${encodeURIComponent(workflow)}&project=${encodeURIComponent(project)}&policyProfile=${encodeURIComponent(policyProfile)}&capture=1`;
  await capture(browserPath, `${base}&view=network&runLimit=25`, "docs/assets/screenshots/dashboard-workflow-network.png");
  await capture(browserPath, `${base}&view=mind-map&runLimit=0`, "docs/assets/screenshots/dashboard-workflow-mind-map.png");
  console.log("Dashboard screenshots updated.");
} finally {
  dashboard.kill("SIGINT");
}

async function waitForDashboard(targetPort, child) {
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${targetPort}/`);
      if (response.ok) return;
    } catch {
      // Keep waiting until the dashboard server is ready.
    }
    if (child.exitCode !== null) {
      throw new Error(`Dashboard exited before becoming ready.\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Dashboard did not become ready on port ${targetPort}.\n${output}`);
}

async function capture(executable, url, outputPath) {
  await fs.mkdir(path.dirname(path.join(rootDir, outputPath)), { recursive: true });
  await new Promise((resolve, reject) => {
    let output = "";
    const child = spawn(executable, [
      "--headless",
      "--disable-gpu",
      "--hide-scrollbars",
      `--window-size=${width},${height}`,
      `--screenshot=${outputPath}`,
      url
    ], { cwd: rootDir, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        console.log(`wrote ${outputPath}`);
        resolve();
      } else {
        reject(new Error(`Screenshot command failed for ${url}\n${output}`));
      }
    });
  });
}

async function findBrowser() {
  const candidates = [
    process.env.AGENTFLOW_SCREENSHOT_BROWSER,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ].filter(Boolean);
  candidates.push(...await playwrightCacheCandidates());
  for (const candidate of candidates) {
    if (candidate && await exists(candidate)) return candidate;
  }
  return null;
}

async function playwrightCacheCandidates() {
  const cacheDir = path.join(process.env.HOME ?? "", "Library", "Caches", "ms-playwright");
  if (!await exists(cacheDir)) return [];
  const entries = await fs.readdir(cacheDir).catch(() => []);
  return entries
    .filter((entry) => entry.startsWith("chromium"))
    .sort((a, b) => b.localeCompare(a))
    .flatMap((entry) => [
      path.join(cacheDir, entry, "chrome-headless-shell-mac-arm64", "chrome-headless-shell"),
      path.join(cacheDir, entry, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing")
    ]);
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
