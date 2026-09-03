#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";

const label = process.env.AGENTFLOW_LAUNCHD_LABEL || "app.makealeft.agent-workflow";
const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);

await launchctl(["bootout", `gui/${process.getuid()}`, plistPath], true);
await launchctl(["disable", `gui/${process.getuid()}/${label}`], true);
await fs.rm(plistPath, { force: true });

console.log(`Removed Agent Workflow LaunchAgent: ${plistPath}`);
console.log("Docker services were left running.");

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
