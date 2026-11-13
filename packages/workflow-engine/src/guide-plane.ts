import {createHash} from 'node:crypto';
import type {StageExecutionInput,StageExecutionOutput} from '../../model-providers/src/types.js';

export const guideNudgeKinds=['none','decompose-next-goal','request-missing-evidence','restore-context','recommend-route','pause-existing-gate'] as const;
export type GuideNudgeKind=typeof guideNudgeKinds[number];
export interface GuideNudge {schemaVersion:1;kind:GuideNudgeKind;message:string;observationIds:string[];authority:'advisory-only'}
export interface GuidePlaneOptions {enabled:true;sampleRate?:number}

export function guideAssignment(runId:string,taskId:string,sampleRate=.8){
 const bounded=Math.max(0,Math.min(1,Number.isFinite(sampleRate)?sampleRate:.8));
 const bucket=parseInt(createHash('sha256').update(`${runId}:${taskId}:guide-v1`).digest('hex').slice(0,8),16)/0xffffffff;
 return {cohort:bucket<bounded?'guided' as const:'unguided' as const,bucket:Number(bucket.toFixed(8)),sampleRate:bounded};
}

export function guideStageInput(stage:StageExecutionInput,observationIds:string[]):StageExecutionInput{
 const boundedIds=[...new Set(observationIds.filter(id=>/^[a-zA-Z0-9:._/-]{1,160}$/u.test(id)))].slice(0,20);
 return {...stage,agentId:'workflow-guide',agentName:'Workflow Guide',modelTier:'fast',modelOverride:undefined,
  agentPrompt:'Observe and guide the process; never act inside it. Return one typed advisory nudge. Never request files, commands, writes, approvals, acceptance, requirement changes, or scope changes.',
  stageGoal:'Choose one bounded next-process nudge from: none, decompose-next-goal, request-missing-evidence, restore-context, recommend-route, pause-existing-gate.',
  compiledBrief:`GUIDE PLANE v1\nAuthority: advisory-only. The primary stage retains all policy, authority, execution, and acceptance decisions.\nObserved receipt IDs: ${boundedIds.join(', ')||'none'}.\nReturn artifact.guideNudge={schemaVersion:1,kind,message,observationIds,authority:'advisory-only'}.`,
  priorReceipts:stage.priorReceipts.slice(-20).map(receipt=>({...receipt,summary:receipt.summary.slice(0,300)})),fileReads:[],stateDeltas:[],memoryContext:[]};
}

/** Provider prose has no force. Only this small schema can enter the primary
 * prompt, and any requested action or acceptance claim invalidates the nudge. */
export function validateGuideNudge(output:StageExecutionOutput,allowedObservationIds:readonly string[]):GuideNudge|null{
 if((output.requestedCommands?.length??0)||(output.requestedFileWrites?.length??0)||(output.requestedFileReads?.length??0)||(output.requestedFileSearches?.length??0)||output.outcome==='blocked')return null;
 const value=output.artifact?.guideNudge as Partial<GuideNudge>|undefined,allowed=new Set(allowedObservationIds);
 if(!value||value.schemaVersion!==1||!guideNudgeKinds.includes(value.kind as GuideNudgeKind)||value.authority!=='advisory-only'||typeof value.message!=='string'||!value.message.trim()||value.message.length>500||!Array.isArray(value.observationIds)||value.observationIds.length>20||value.observationIds.some(id=>typeof id!=='string'||!allowed.has(id)))return null;
 return {schemaVersion:1,kind:value.kind as GuideNudgeKind,message:value.message.trim(),observationIds:[...new Set(value.observationIds)],authority:'advisory-only'};
}

export function applyGuideNudge(stage:StageExecutionInput,nudge:GuideNudge):StageExecutionInput{
 if(nudge.kind==='none')return stage;
 return {...stage,priorReceipts:[...stage.priorReceipts,{agentId:'workflow-guide',actionType:`guide_${nudge.kind}`,summary:`Advisory only: ${nudge.message}`}].slice(-100)};
}
