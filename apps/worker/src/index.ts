import { runWorkerOnce } from "../../../packages/workflow-engine/src/executor.js";

export async function startWorker(limit = 1): Promise<void> {
  const result = await runWorkerOnce(limit);
  console.log(`Worker claimed ${result.claimed}, completed ${result.completed}, failed ${result.failed}.`);
}
