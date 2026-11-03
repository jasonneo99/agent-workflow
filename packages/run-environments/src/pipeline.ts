import type { ProjectConfig, WorkflowDefinition } from '../../agent-registry/src/schemas.js';

export const RUN_PIPELINE_VERSION = 1;
const sourceVerificationPrefix = 'Source-phase verification before trusted source integration.';
export interface RunPipelineContract {
  version: 1;
  required: boolean;
  sourceChanges: boolean;
  isolation: 'worktree' | 'read-only' | 'project-artifacts';
  preparedOnly: boolean;
  checkpointStageIds: string[];
  sourcePaths?: string[];
  artifactPaths?: string[];
}
export const projectContextArtifactPaths = ['AGENTS.md','.agent-workflow/context.md','.agent-workflow/commands.md','.agent-workflow/decisions.md','.agent-workflow/memory.md'] as const;
export function projectArtifactPaths(project: ProjectConfig, workflow: WorkflowDefinition): string[] {
  if(workflow.execution?.kind!=='project-artifacts')return [];
  if(!workflow.execution.artifact_paths?.length)throw Error('Project-artifact workflows need exact artifact paths');
  return [...new Set(workflow.execution.artifact_paths.map(value=>{
    const relative=value==='project.roadmap_path'?project.project.roadmap_path:value;
    if(!validProjectArtifactPath(relative,project))throw Error('Invalid project artifact path: '+relative);
    return relative;
  }))];
}
export function validProjectArtifactPath(relative:string,project:ProjectConfig):boolean {
  if(projectContextArtifactPaths.some(value=>value===relative))return true;
  return relative===project.project.roadmap_path&&relative.endsWith('.md')
    &&relative.split('/').every((part,index)=>(part!=='.'&&part!=='..'&&part!=='node_modules'&&/^[A-Za-z0-9_][A-Za-z0-9_. -]*$/u.test(part))||(index===0&&part==='.agent-workflow'));
}
const readOnly = new Set(['review-pr','code-review','security-audit','product-discovery','architecture-decision','roadmap-curation','ship-release','production-readiness','model-improvement']);
export function sourceChangingWorkflow(workflow: WorkflowDefinition): boolean {
  if (workflow.execution) return workflow.execution.kind === 'source-change';
  if (readOnly.has(workflow.id)) return false;
  return workflow.stages.some(stage => ['react','executor'].includes(stage.pattern.type)
    || ['implementation-agent','frontend-engineer','backend-engineer','database-engineer','docs-maintainer','auto-docs-update'].includes(stage.agent));
}

/** Normalize new executions only. Historical snapshots are never rewritten. */
export function preparedWorkflow(workflow: WorkflowDefinition, required: boolean, repair: WorkflowDefinition): WorkflowDefinition {
  if (!required || !sourceChangingWorkflow(workflow)) return workflow;
  let stages = workflow.stages.filter(stage=>!stage.runtime_operation).map(stage => ({ ...stage, depends_on: stage.depends_on ? [...stage.depends_on] : undefined }));
  if (stages.length === 1) {
    const original = stages[0]!;
    stages = repair.stages.filter(stage=>!stage.runtime_operation).map(stage => ({ ...stage, depends_on: undefined }));
    stages[0] = { ...stages[0]!, agent: original.agent, goal: `${original.goal}\n${stages[0]!.goal}`,
      pattern:{...stages[0]!.pattern,...(original.pattern.requires_source_writes===undefined?{}:{requires_source_writes:original.pattern.requires_source_writes})} };
  }
  // Each source phase ends at a verifier. Add a final verifier for a workflow
  // whose documentation/packaging stages follow its earlier source review.
  if (stages.at(-1)?.pattern.type !== 'verifier') {
    const id = stages.some(stage => stage.id === 'verify') ? 'verify-final-source' : 'verify';
    stages.push({ ...repair.stages[1]!, id, depends_on: undefined });
  }
  let phaseStart = 0;
  for (let index = 0; index < stages.length; index++) {
    if (stages[index]!.pattern.type !== 'verifier') continue;
    const source = stages.slice(phaseStart,index);
    const last = source.at(-1);
    if (last) {
      const previous = stages.slice(0,index - 1).map(stage => stage.id);
      stages[index - 1] = { ...last, checkpoint_after: true,
        depends_on: [...new Set([...(last.depends_on ?? []), ...previous])] };
    }
    stages[index] = { ...stages[index]!, depends_on: [...new Set([...(stages[index]!.depends_on ?? []), ...stages.slice(0,index).map(stage => stage.id)])] };
    phaseStart = index + 1;
  }
  const integration=repair.stages.find(stage=>stage.runtime_operation==='integrate-source');
  if(!integration)throw Error('Prepared source execution requires the trusted integration phase');
  stages.push({...integration,depends_on:stages.map(stage=>stage.id)});
  stages=stages.map((stage,index)=>({...stage,depends_on:[...new Set([...(stage.depends_on??[]),...(index?[stages[index-1]!.id]:[])])]}));
  stages=stages.map(stage=>stage.pattern.type==='verifier'&&!stage.goal.startsWith(sourceVerificationPrefix)?{...stage,goal:`${sourceVerificationPrefix} ${stage.goal}\nRun the committed candidate's declared verification recipes in its selected environment first. Preserve every explicit source acceptance requirement, including a required full suite. Do not substitute an unrelated default-profile suite for the candidate's declared checks. Installation, deployment, launch and visible runtime acceptance are downstream required obligations: record them as pending, never as passed source evidence. Source-phase completion does not establish overall product acceptance.`}:stage);
  return { ...workflow, execution: {kind:'source-change'}, stages };
}
export function pipelineContract(project: ProjectConfig, workflow: WorkflowDefinition, installationRequired: boolean, preparedOnly = false): RunPipelineContract {
  const required = installationRequired || project.execution?.pipeline?.required === true;
  const sourceChanges = sourceChangingWorkflow(workflow);
  const artifacts=workflow.execution?.kind==='project-artifacts';
  return { version:1, required, sourceChanges, isolation:sourceChanges?'worktree':artifacts?'project-artifacts':'read-only', preparedOnly,
    ...(artifacts?{artifactPaths:projectArtifactPaths(project,workflow)}:{}),
    checkpointStageIds:workflow.stages.filter(stage=>stage.checkpoint_after).map(stage=>stage.id) };
}
