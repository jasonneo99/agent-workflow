/** Read live local identity and emit a governed storage-backed metrics report.
 * Run inside an allowed worker command so its output has current-run provenance.
 * Never print environment dumps, credentials, or claim terminal acceptance.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import dotenv from "dotenv";
import { agentWorkflowEnvPath } from "../packages/runtime-root/src/index.js";
import { sourceSubjectHash } from "../packages/workflow-engine/src/source-subject.js";
import { workflowAutomaticRepairEnabled } from "../apps/cli/src/workflow-supervision.js";
import { getWorkflowRunDetails, reportWorkflowDeliveryMetrics, verifyRunReceiptChain } from "../packages/storage/src/postgres.js";

dotenv.config({ path: agentWorkflowEnvPath(process.cwd()), quiet: true });
dotenv.config({ path: ".agent-workflow/runtime.env", quiet: true, override: true });
const runId = process.argv[process.argv.indexOf("--run") + 1];
if (!process.argv.includes("--run") || !/^[a-f0-9-]{36}$/iu.test(runId)) throw new Error("Provide --run with the current workflow run id.");
const details = await getWorkflowRunDetails(runId);
if (!details.run || path.resolve(details.run.projectRootUri) !== process.cwd()) throw new Error("Runtime observation must execute in the run project.");
const contract = details.run.evaluationMetadata.acceptanceContract as { subjectHash: string; sourcePaths: string[] } | undefined;
if (!contract?.sourcePaths?.length) throw new Error("Runtime observation requires a frozen source scope.");
const subjectHash = await sourceSubjectHash(process.cwd(), contract.sourcePaths);
if (subjectHash !== contract.subjectHash) throw new Error("Runtime observation source does not match the enrolled candidate.");
const readJson = async (file: string) => JSON.parse(await fs.readFile(file, "utf8"));
const worker = await readJson(".agent-workflow/runtime/worker-heartbeat.json");
const supervisor = await readJson(".agent-workflow/runtime/supervisor-heartbeat.json");
const settings = await readJson(".agent-workflow/learning/settings.json");
const observations = [];
for (const [role, heartbeat] of [["worker", worker], ["supervisor", supervisor]] as const) {
  if (!Number.isSafeInteger(heartbeat.pid) || heartbeat.pid <= 1 || heartbeat.status !== "running"
    || !Number.isFinite(Date.parse(heartbeat.lastHeartbeatAt)) || Math.abs(Date.now() - Date.parse(heartbeat.lastHeartbeatAt)) > 60_000) {
    throw new Error(`${role} heartbeat is not live.`);
  }
  // Only the one non-secret opt-in flag is extracted; discard the raw process environment.
  const processText = execFileSync("ps", ["eww", "-p", String(heartbeat.pid), "-o", "command="], { encoding: "utf8" });
  if (!processText.includes(role === "worker" ? "apps/cli/src/index.ts worker" : "scripts/dev-agentflow.mjs")) throw new Error(`${role} process identity mismatch.`);
  const autoRepair = processText.match(/(?:^|\s)AGENTFLOW_WORKFLOW_AUTO_REPAIR=([^\s]*)/u)?.[1];
  if (workflowAutomaticRepairEnabled(autoRepair)) throw new Error(`${role} automatic repair is enabled.`);
  const processStarted = Date.parse(execFileSync("ps", ["-p", String(heartbeat.pid), "-o", "lstart="], { encoding: "utf8" }).trim());
  if (!Number.isFinite(processStarted) || Math.abs(processStarted - Date.parse(heartbeat.startedAt)) > 10_000) throw new Error(`${role} process start does not match heartbeat.`);
  const manifest = await Promise.all(contract.sourcePaths.map(async file => ({ file, modifiedAtMs: (await fs.stat(file)).mtimeMs })));
  if (manifest.some(file => file.modifiedAtMs > processStarted)) throw new Error(`${role} predates the candidate source; reload required.`);
  observations.push({ role, pid: heartbeat.pid, startedAt: heartbeat.startedAt, lastHeartbeatAt: heartbeat.lastHeartbeatAt,
    runtimeVersion: heartbeat.runtimeVersion, automaticRepairEnabled: false, sourcePredatesProcess: true });
}
if (workflowAutomaticRepairEnabled(process.env.AGENTFLOW_WORKFLOW_AUTO_REPAIR) || settings.daemonMode !== "observe") throw new Error("Configured live self-repair is not disabled.");
const chain = await verifyRunReceiptChain(runId);
if (!chain.valid) throw new Error("Current run receipt chain is invalid.");
const metrics = await reportWorkflowDeliveryMetrics(runId);
console.log(JSON.stringify({ kind: "runtime_observation", runId, observedAt: new Date().toISOString(), subjectHash,
  identityAssurance: "live-process-command-heartbeat-and-candidate-source-timestamps", observations,
  daemonMode: settings.daemonMode, automaticRepairEnabled: false, receiptChain: chain, metrics,
  terminalAcceptanceClaimed: false, cleanAcceptanceClaimed: false }, null, 2));
