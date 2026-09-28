#!/usr/bin/env tsx
import fs from "node:fs/promises";
import { compareWorkflowToDirect, type WorkflowTiming } from "../packages/perf-harness/src/index.js";

function required(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function readTiming(file: string): Promise<WorkflowTiming> {
  const value = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  const fields = ["totalMs", "queueDelayMs", "modelLatencyMs", "commandExecutionMs", "approvalWaitMs", "orchestrationOverheadMs", "retries", "usefulParallelism"] as const;
  for (const field of fields) {
    if (typeof value[field] !== "number" || !Number.isFinite(value[field]) || value[field] < 0) throw new Error(`${file}: ${field} must be a finite non-negative number`);
  }
  return value as WorkflowTiming;
}

const directFile = required("--direct");
const workflowFile = required("--workflow");
const maximumMultiplier = Number(required("--max-multiplier"));
const [direct, workflow] = await Promise.all([readTiming(directFile), readTiming(workflowFile)]);
const comparison = compareWorkflowToDirect({ direct, workflow, maximumMultiplier });
console.log(JSON.stringify({ kind: "agentflow_workflow_speed_comparison", version: 1, directFile, workflowFile, maximumMultiplier, ...comparison }, null, 2));
if (!comparison.passed) process.exitCode = 1;
