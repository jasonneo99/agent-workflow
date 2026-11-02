import type {ProjectConfig} from "../../agent-registry/src/schemas.js";
import type {RunPipelineContract} from "../../run-environments/src/pipeline.js";

/** Prepared source phases commit after all their authors have finished, before
 * the independent verifier. Legacy stage-name configuration cannot split a phase.
 */
export function shouldCheckpointSourcePhase(task: {stageId:string;checkpointAfter?:boolean;executionPipeline?:RunPipelineContract}, project:ProjectConfig):boolean {
  if(!project.execution.repair_commits?.enabled)return false;
  if(task.executionPipeline?.required)return task.executionPipeline.sourceChanges&&task.checkpointAfter===true;
  return task.checkpointAfter===true||project.execution.repair_commits.stages.includes(task.stageId);
}
