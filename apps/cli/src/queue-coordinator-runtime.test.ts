import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {candidateMatchesCurrentContract,prepareUnstartedResumeProjection,historicalRecoveryDiagnostic,heldFamilyNextAction,nonLeasableCoordinatorHold,prepareQuarantinedAssessmentProjection,isRetryableCoordinatorConflict,provenanceGapCohortKey,buildProvenanceCohortReviews} from './commands/queue-coordinator.js';
import {QUEUE_SHARED_ITEM_LIMIT,planQueueCoordinator,type QueueCoordinatorFamily} from '../../../packages/workflow-engine/src/queue-coordinator-plan.js';

const source = () => readFileSync(new URL("./commands/queue-coordinator.ts", import.meta.url), "utf8");
const daemonSource = () => readFileSync(new URL("./commands/daemon.ts", import.meta.url), "utf8");
test('provenance gap cohorts are stable, project-scoped and body-free',()=>{
 const a=provenanceGapCohortKey('project-a',['missing scope','missing contract','missing scope']);
 assert.equal(a,provenanceGapCohortKey('project-a',['missing contract','missing scope']));
 assert.notEqual(a,provenanceGapCohortKey('project-b',['missing contract','missing scope']));
 assert.doesNotMatch(a??'',/missing|contract|scope/);
});
test('provenance cohort reviews retain exact members without task bodies or shared grants',()=>{
 const member={familyId:'p:set',sourceRunId:'run',projectId:'p',projectRootUri:'/p',canonical:true,activeRunIds:[],pendingApprovalIds:[],fileScopes:['src/a.ts'],failureFingerprint:'f',priorFingerprint:null,repairDepth:0,verificationReady:false,originalAcceptancePresent:false,sourceEvidenceReady:false,blocker:'private task detail',sharedBlockerKey:'provenance-gap:p:key'} satisfies QueueCoordinatorFamily;
 const reviews=buildProvenanceCohortReviews([member],[{familyId:'p:set',sourceRunId:'run',reasons:['missing scope']}],new Map([['run',{provider_override:'codex-cli',model_tier_override:'standard'}]]),[{sourceRunId:'run',state:'proposal'}]);
 assert.equal(reviews[0]?.decisionMode,'separate-immutable-per-family');assert.equal(reviews[0]?.members[0]?.proposalState,'proposal');
 assert.equal(JSON.stringify(reviews).includes('private task detail'),false);assert.deepEqual(reviews[0]?.members[0]?.sourcePaths,['src/a.ts']);
});
test('batch provenance decisions are an exact non-executing mode',()=>{
 const code=source();
 assert.match(code,/\.option\('--decide-provenance-cohort <file>'/);
 assert.match(code,/recordProvenanceCohortDecisions\(input\)/);
 assert.match(code,/A provenance cohort decision is one explicit reviewed action, not an execution or discovery mode/);
});
test('verified code repairs durably notify only the captured original request',()=>{
 const storage=readFileSync(new URL('../../../packages/storage/src/queue-coordinator.ts',import.meta.url),'utf8');
 assert.match(storage,/state==='verified'&&claim\.role==='verifier'&&claim\.revisionCandidateId/);
 assert.match(storage,/eventKey:`queue-partner-code-fix:\$\{claim\.id\}:\$\{claim\.fence\}`/);
 assert.match(storage,/kind:'recovered'/);
 assert.match(storage,/evaluation_metadata->>'codexThreadId'.*originClient.*originTaskId/s);
 assert.ok(storage.indexOf('await enqueueRunNotification(c')<storage.indexOf('await writeAudit(c,claim.sourceRunId,"queue_coordinator_finished"'));
});
test('queue cards distinguish verified-fix callback queue, transport and acknowledgment evidence',()=>{
 const storage=readFileSync(new URL('../../../packages/storage/src/postgres.ts',import.meta.url),'utf8');
 const dashboard=readFileSync(new URL('./commands/daemon.ts',import.meta.url),'utf8');
 assert.match(storage,/queue-partner-code-fix:%/);
 assert.match(storage,/acknowledged_at is not null then 'acknowledged'/);
 assert.match(storage,/transport_accepted_at is not null.*then 'transport_accepted'/s);
 assert.match(dashboard,/Verified fix callback:/);
 assert.match(dashboard,/Verification, transport acceptance, and requester acknowledgment are separate evidence/);
});
test('runtime-owned failures require a live compatible worker capability before replay can be considered',()=>{
 const storage=readFileSync(new URL('../../../packages/storage/src/failure-ownership.ts',import.meta.url),'utf8');
 const daemon=daemonSource();
 assert.match(storage,/requiredWorkerCapability:'python-pycompile-glob-v1'/);
 assert.match(daemon,/const next=\(await probeCommandExecutionCapabilities\(\)\)\.map/);
 assert.match(daemon,/executionCapabilities: executionCapabilityProbes\.filter\(probe=>probe\.status==="passed"\)\.map\(probe=>probe\.id\)/);
 assert.match(daemon,/executionCapabilityProbes,/);
 assert.match(daemon,/AGENTFLOW_EXECUTION_CAPABILITY_PROBE_INTERVAL_MS\?\?"60000"[\s\S]*?Math\.min\(3_600_000,Math\.max\(15_000/);
 assert.match(daemon,/executionCapabilityProbeRefresh[\s\S]*?executionCapabilityProbes=next[\s\S]*?lastExecutionCapabilityProbeAt=Date\.now\(\)/);
 assert.match(daemon,/onTick: async \(result\) => \{[\s\S]*?refreshExecutionCapabilityProbes\(result\.failed>0\)[\s\S]*?writeHeartbeat/);
 assert.match(daemon,/evaluateWorkerHeartbeatTrust\(heartbeat,trustStore\)[\s\S]*?!trustDecision\.trusted[\s\S]*?heartbeat\.status!=="running"[\s\S]*?ageMs>staleAfterMs/);
 assert.match(daemon,/projectRootUri=typeof heartbeat\.projectRootUri==="string"\?path\.resolve\(heartbeat\.projectRootUri\):null/);
 assert.match(daemon,/project_identity_locations l on l\.project_id=p\.id[\s\S]*?workerSourceRevision=projectRootUri\?\(await execFileText\(ctx,"git",\["-C",projectRootUri,"rev-parse","HEAD"\]/);
 assert.match(daemon,/workerEligibleForQueueProject[\s\S]*?worker\.projectRootUri===null[\s\S]*?worker\.projectIdentityId===item\.projectIdentityId&&worker\.sourceRevision===item\.sourceRevision/);
 assert.match(daemon,/workerEligibilityReason\(capableWorkers,item,workerIds\.length\)/);
 assert.match(daemon,/state: workerIds\.length \? "compatible-worker-active"[\s\S]*?: "awaiting-worker-rollout"/);
 assert.match(daemon,/This readiness check does not authorize replay/);
 assert.match(daemon,/loadLatestWorkerCapabilityProbes[\s\S]*?workerState:[^=]+=!trustDecision\.trusted\?"untrusted"[\s\S]*?observation\.checkedAt>prior\.checkedAt/);
 assert.match(daemon,/Latest probe \$\{runtimeRemedy\.latestProbe\.status\}[\s\S]*?digest \$\{runtimeRemedy\.latestProbe\.digest\.slice\(0,12\)\}/);
 assert.match(daemon,/Execution Capabilities[\s\S]*?Capability Probes/);
 assert.match(daemon,/AGENTFLOW_WORKER_ATTESTATION_PRIVATE_KEY_FILE[\s\S]*?workerRuntimeBuildDigest[\s\S]*?signWorkerHeartbeat/);
 assert.match(daemon,/Heartbeat Trust[\s\S]*?Runtime Build/);
 assert.match(daemon,/\.command\("worker-host-trust"\)[\s\S]*?No files changed\. Re-run with --write --actor <name>[\s\S]*?applyWorkerHostRegistryPlan/);
 assert.match(daemon,/\/api\/worker-heartbeat-ingest[\s\S]*?validateServerMutationAuth\(request\)[\s\S]*?ingestRemoteWorkerHeartbeat[\s\S]*?remote-ingestion-cursors\.state/);
 assert.match(daemon,/loadRemoteWorkerHeartbeatHealth[\s\S]*?remoteFleetTrust[\s\S]*?Remote Fleet Attestation[\s\S]*?Delivery lag[\s\S]*?Worker freshness/);
 assert.match(daemon,/server-readiness:[\s\S]*?loadDashboardWorkerStatus\(\)[\s\S]*?Worker and Fleet Delivery[\s\S]*?authenticated remote delivery/);
 assert.match(daemon,/fleetTransportDelayed[\s\S]*?fleetWorkerUnhealthy[\s\S]*?Heartbeat transport delayed[\s\S]*?does not prove the worker itself is unhealthy[\s\S]*?Worker or trust health needs attention/);
 assert.match(daemon,/if \(action === "retry-runtime-fixed"\)[\s\S]*?ownership\?\.owner!=="agent-workflow-runtime"[\s\S]*?workerEligibleForQueueProject\(worker,item\)[\s\S]*?Replay refused: \$\{workerEligibilityReason\(capableWorkers,item,0\)\}/);
 assert.match(daemon,/sourceRunId,[\s\S]*?preserveCompletedCheckpoints:true[\s\S]*?runtimeRemedy:\{evidenceRunId:sourceRunId,repairRoute:ownership\.repairRoute,classificationConfidence:ownership\.confidence,requiredCapability:capability,attestedWorkerIds:workerIds/);
 assert.match(daemon,/runtimeRemedy\?\.state==="compatible-worker-active"[\s\S]*?"retry-runtime-fixed","Replay validation once"[\s\S]*?Await worker rollout/);
});
test('queue cards expose evidence-bound failure ownership without granting repair',()=>{
 const storage=readFileSync(new URL('../../../packages/storage/src/postgres.ts',import.meta.url),'utf8');
 const dashboard=readFileSync(new URL('./commands/daemon.ts',import.meta.url),'utf8');
 assert.match(storage,/classifyFailureOwnership/);assert.match(storage,/kind='command_output'/);
 assert.match(dashboard,/Failure owner:/);assert.match(dashboard,/Classification grants no repair or replay authority/);
});
test('operator inbox affects ranking before planning without bypassing the existing planner',()=>{
 const code=source(),load=code.indexOf('const operatorRequests=await prepare(()=>loadPartnerOperatorRequests'),rank=code.indexOf('data.families=prioritizePartnerRequests'),plan=code.indexOf('const plan=planQueueCoordinator');
 assert.ok(load>0&&rank>load&&plan>rank);assert.match(code,/ownershipRoutes,operatorRequests,admission,resolutionYield,(?:delegationEfficiency,)?provenanceCohortReviews,repairLanes:QUEUE_SHARED_ITEM_LIMIT,verifierLanes:1/);
});
test('explicit queue-wide mode refreshes registered projects and families each pass, preserving bounded legacy modes',()=>{
 const code=source();assert.match(code,/\.option\('--all-queued-projects'/);assert.match(code,/options.allQueuedProjects&&\(options.project\?\.length\|\|options.enrollLegacy/);
 const loop=code.indexOf('const pass=async(onSettled?'),discovery=code.indexOf('const discovery=await prepare(()=>discoverPartnerProjects())',loop),refresh=code.indexOf('passEnrolled=new Set(current.families',discovery),tick=code.indexOf('...await tick(ctx',refresh);
 assert.ok(loop>0&&discovery>loop&&refresh>discovery&&tick>refresh);assert.match(code,/if\(discovery.truncated\)throw Error/);assert.match(code,/discoveryHolds=discovery.holds/);
 assert.match(code,/managed.has\(`\$\{f.familyId\}:\$\{f.sourceRunId\}`\)/);assert.match(code,/scope:options.allQueuedProjects\?'queue':'explicit-projects'/);
});
test('watch survives an ownership conflict without swallowing other failures or retrying one-shot effects',()=>{
 const conflict=new Error('Work intent conflicts with active owner another-client.');
 assert.equal(isRetryableCoordinatorConflict(conflict,true),true);
 assert.equal(isRetryableCoordinatorConflict(conflict,false),false);
 for(const error of [new Error('Storage unavailable'),new Error('Claim fence changed'),new Error('Work intent conflicts with active owner forged.\nother error'),{message:conflict.message}])assert.equal(isRetryableCoordinatorConflict(error,true),false);
 const code=source();assert.ok(code.includes('if(!isRetryableCoordinatorConflict(error,Boolean(options.watch)))throw error;'));
 assert.match(code,/state:'waiting-for-owner'/);assert.match(code,/watchPartnerQueue\(\{pass,report,intervalMs:interval,signal:shutdown.signal\}\)/);
});
test('watch backfills from finalized items, captures per-pass inventory and drains on shutdown',()=>{
 const code=source();assert.match(code,/\},\{onSettled\}\):\[\]/);assert.match(code,/passRoots=\[\.\.\.projectRoots\],passEnrolled=new Set\(enrolled\)/);assert.equal(QUEUE_SHARED_ITEM_LIMIT,5,'Independent verification remains inside the documented five-item ceiling');assert.match(code,/workTarget:\{minimum:3,optimal:QUEUE_SHARED_ITEM_LIMIT,stretch:QUEUE_SHARED_ITEM_LIMIT,verifierIncluded:true,stretchRequiresMeasuredCapacity:true\}/);assert.match(code,/verifierOccupied:occupiedAssignments.some/);assert.match(code,/occupiedRepairLanes:occupiedAssignments.filter/);
 assert.match(code,/const shutdown=new AbortController\(\),stop=\(\)=>\{shutdown.abort\(\);\}/);assert.doesNotMatch(code,/shouldStop:\(\)=>shutdown.signal.aborted/);
});
test('live worker/provider capacity bounds new admission before planning and remains visible in the report',()=>{
 const code=source(),read=code.indexOf("worker-heartbeat.json"),active=code.indexOf("select count(*)::int n from workflow_tasks where status in ('leased','running')"),derive=code.indexOf('deriveQueueAdmissionPressure',active),plan=code.indexOf('const plan=planQueueCoordinator');
 assert.ok(read>0&&active>read&&derive>active&&plan>derive);assert.match(code,/occupiedRepairLanes:[\s\S]*?,admission,adaptiveStrategyOrder\}/);
 assert.equal(QUEUE_SHARED_ITEM_LIMIT,5);assert.match(code,/operatorRequests,admission,resolutionYield,(?:delegationEfficiency,)?provenanceCohortReviews,repairLanes:QUEUE_SHARED_ITEM_LIMIT/);
});
test('delegation efficiency is measured before planning output and remains shadow-only',()=>{
 const code=source(),load=code.indexOf('const delegationEfficiency=await queuePartnerDelegationEfficiency()'),report=code.indexOf('delegationEfficiency,provenanceCohortReviews');
 assert.ok(load>0&&report>load);assert.match(code,/queuePartnerDelegationEfficiency/);
});
test('a stop crosses discovery and enrollment boundaries before any new reservation but never cancels an owned worker',()=>{
 const code=source();assert.match(code,/partnerPreparationStep\(read,shouldStop\)/);assert.match(code,/execute,shouldStop\)\)/);assert.match(code,/advanceAuthorizedPartnerEnrollments\(ctx.rootDir,projectRoots,shouldStop\)/);
 assert.match(code,/if\(shouldStop\?\.\(\)\)\{await releaseWorkIntent\(\{projectId:family.projectId,owner,fencingToken:intent.fencingToken\}\);return null;\}/);assert.match(code,/error instanceof PartnerPlanningStopped/);
 assert.doesNotMatch(code,/shouldStop:\(\)=>shutdown.signal.aborted/);
});
test('assessment and verifier imports recheck stop before reservation and release only the unclaimed intent',()=>{
 const code=source();
 assert.match(code,/const \{reserveHistoryPreservingAssessment\}=await prepare\(\(\)=>import\('\.\.\/\.\.\/\.\.\/\.\.\/packages\/storage\/src\/history-preserving-assessment.js'\)\)/);
 assert.match(code,/const \{reconcileBlockedVerifier\}=await prepare\(\(\)=>import\('\.\.\/\.\.\/\.\.\/\.\.\/packages\/storage\/src\/queue-coordinator.js'\)\)/);
 assert.match(code,/catch\(e\)\{await releaseWorkIntent\(\{projectId:family.projectId,owner,fencingToken:intent.fencingToken\}\);if\(e instanceof PartnerPlanningStopped\)return null;throw e;\}/);
});
test('legacy regression feasibility precedes reservation and worker sees frozen commands',()=>{
 const code=source();
 const preflight=code.indexOf('const admissionPlan=planPartnerAdmission');assert.ok(preflight>=0);
 assert.ok(preflight<code.indexOf('const claim=await reserveQueueCoordinator'));
 assert.ok(preflight<code.indexOf('const intent=await acquireWorkIntent({projectId:family.projectId,owner,objective:`${role}'));
 assert.ok(code.indexOf('enforcePartnerAdmission(prepared')<code.indexOf('const claim=await reserveQueueCoordinator'));
 assert.match(code,/CURRENT FROZEN COMMAND ALLOWLIST/);
 assert.match(code,/if\(source.legacyEnrollmentId&&!assessing&&!resuming\)/,'Both repairs and independent verifiers require executable recipes');
});
test('current repair dispositions remain a post-execution observation, never planner authority',()=>{
 const code=source();
 assert.ok(code.indexOf('const latestChildren=await loadLatestRepairDispositions')>code.indexOf('const plan=planQueueCoordinator'));
 assert.match(code,/latestChild:latestChildren.get\(source.id\)/);
 assert.match(code,/dispositions,dispositionCounts,repairs:/);
 assert.doesNotMatch(code,/failureFingerprint\s*=\s*.*disposition/);
});
test('quarantine overlap planning uses exact stored approval and reservation repeats validation',()=>{
 assert.match(source(),/loadApprovedQuarantineOverlapOnClient\(c,\{sourceRunId:source.id/);
 assert.match(source(),/exception\?\.ignoredRunIds.length===1/);
 const storage=readFileSync(new URL('../../../packages/storage/src/queue-coordinator.ts',import.meta.url),'utf8');
 assert.ok(storage.indexOf("pg_advisory_xact_lock")<storage.indexOf('if(input.quarantineOverlap)'));
 assert.match(storage,/input.role!=='repair'/);
 assert.match(storage,/exception.authorizationReceiptHash!==input.quarantineOverlap.authorizationReceiptHash/);
 assert.match(storage,/exception.ignoredRunIds\[0\]!==input.quarantineOverlap.blockedCloneRunId/);
});

test('explicit assessment projection excludes only the exact authority-validated quarantine set',()=>{
 const family:QueueCoordinatorFamily={familyId:'family',sourceRunId:'source',projectId:'project',projectRootUri:'/synthetic',canonical:true,activeRunIds:['queued-clone'],reconciliationHoldReason:'exact assignment reconciliation required',pendingApprovalIds:[],fileScopes:['src/exact.ts'],failureFingerprint:'original',priorFingerprint:'original',repairDepth:0,verificationReady:false,originalAcceptancePresent:true,sourceEvidenceReady:true,blocker:'historical'};
 const before=JSON.stringify(family),projection=prepareQuarantinedAssessmentProjection(family,['queued-clone']);
 assert.deepEqual(projection?.activeRunIds,[]);assert.deepEqual(projection?.fileScopes,family.fileScopes);assert.equal(JSON.stringify(family),before);
 for(const ids of [[],['other'],['queued-clone','other'],['queued-clone','queued-clone']])assert.equal(prepareQuarantinedAssessmentProjection(family,ids),null);
 assert.equal(prepareQuarantinedAssessmentProjection({...family,reconciliationHoldReason:undefined},['queued-clone']),null);
 const code=source();const start=code.indexOf('const ignored=await previewQuarantinedHistoryAssessment');const use=code.indexOf('prepareQuarantinedAssessmentProjection(family,ignored)');assert.ok(start>=0&&use>start);
 assert.match(code,/for\(const command of assessmentCommands\)assertCommandAllowed\(command,resolved.project\)/);
});

test('non-leasable projection needs exact DB invalidity for every queued coordinator descendant',()=>{
 const queued={id:'stranded',status:'queued',metadata:{queueCoordinatorClaimId:'copied'}};
 assert.match(nonLeasableCoordinatorHold(['stranded'],[queued],new Set(['stranded']),true)??'',/cannot be leased/);
 assert.equal(nonLeasableCoordinatorHold(['stranded'],[queued],new Set(['stranded'])),undefined,'Missing trigger proof keeps capacity conservative');
 assert.equal(nonLeasableCoordinatorHold(['stranded'],[queued],new Set(['stranded']),false),undefined,'Disabled or unknown trigger proof keeps capacity conservative');
 assert.equal(nonLeasableCoordinatorHold(['stranded'],[queued],new Set(),true),undefined,'Missing DB proof counts capacity normally');
 for(const status of ['running','leased'])assert.equal(nonLeasableCoordinatorHold(['stranded'],[{...queued,status}],new Set(['stranded']),true),undefined);
 assert.equal(nonLeasableCoordinatorHold(['stranded'],[{...queued,metadata:{}}],new Set(['stranded']),true),undefined,'Ordinary queued work counts capacity normally');
 for(const other of ['real-active','reservation:uncertain','reservation:reserved'])assert.equal(nonLeasableCoordinatorHold(['stranded',other],[queued],new Set(['stranded']),true),undefined,'Mixed active family retains full conservative capacity');
 assert.equal(nonLeasableCoordinatorHold([],[],new Set(),true),undefined);
 const code=source();assert.match(code,/a.child_run_id=r.id/);assert.match(code,/a.project_id=r.project_id/);assert.match(code,/a.fence::text=r.evaluation_metadata->>'queueCoordinatorFence'/);assert.match(code,/i.expires_at>clock_timestamp\(\)/);
 assert.match(code,/count\(distinct t.tgrelid\)=2/);assert.match(code,/t.tgenabled in \('O','A'\)/);assert.match(code,/t.tgfoid=to_regprocedure\('agentflow_coordinator_claim_fence\(\)'\)/);assert.match(code,/\.catch\(\(\)=>false\)/);
 assert.match(code,/healthyActive=family.activeRunIds.length>0&&!family.reconciliationHoldReason/);
 assert.match(heldFamilyNextAction('queued coordinator lineage cannot be leased; exact assignment reconciliation required',[]),/never generic replay, cancellation or inherited lease reuse/);
});

test('explicit managed self-repair uses existing coordinator and scoped ownership without legacy daemon activation',()=>{
 const code=source();assert.match(code,/\.option\('--manage-self-repair'/);
 assert.match(code,/options.manageSelfRepair&&\(!options.execute\|\|\(!options.project\?\.length&&!options.allQueuedProjects\)/);
 assert.match(code,/enablePartnerRepairManagement\(\{projectId:family.projectId,sourceRunId:family.sourceRunId/);
 assert.match(code,/runtime\/queue-partner\/repair-management/);
 assert.match(code,/reserveSupervisedRepair\(\{runId:source.id,task:source.task,failure:source.blocker,coordinatorClaim:/);
 assert.doesNotMatch(code,/AGENTFLOW_WORKFLOW_AUTO_REPAIR\s*=/);
});

test('unused-slot unblock advice is concrete without inventing evidence or authority',()=>{
 assert.match(heldFamilyNextAction('missing source evidence or original acceptance',['missing explicit original provider/tier binding']),/original enrollment artifacts.*provider\/tier.*separately authorized/);
 assert.match(heldFamilyNextAction('missing source evidence or original acceptance',['evaluation or training has separate authorization']),/exact original evaluation authorization/);
 assert.match(heldFamilyNextAction('external proof or authority required',[]),/offline tests cannot substitute/);
 assert.match(heldFamilyNextAction('family already active',[]),/do not create another attempt/);
 assert.match(heldFamilyNextAction('same repaired revision already assessed; explicit reconciliation required',[]),/no reset, duplicate repair or automatic review replay/);
});

test('independent acceptance is revalidated even when a repair candidate exists',()=>{
 const code=source();
 assert.doesNotMatch(code,/if\(ready&&!candidate\)/);
 const start=code.indexOf('if(ready){');
 const end=code.indexOf('if(ready&&candidate)');
 assert.ok(start>0&&end>start);
 const block=code.slice(start,end);
 assert.match(block,/a.role==='verifier'&&a.state==='verified'&&a.child_run_id/);
 assert.match(block,/verifyIndependentAcceptanceReviewOnClient/);
 assert.match(block,/if\(independentlyAccepted\)\{verifiedRevisions.push\(familyId\);continue;\}/);
});

test('explicit verifier reconciliation preserves terminal predecessor and never selects repairs',()=>{
 const code=source();
 assert.match(code,/if\(reconciling\)\{plan.repairs=\[\];plan.verifiers=plan.verifiers.filter/);
 assert.match(code,/reconcileBlockedVerifier\(\{assignmentId:reconciling.id,owner,intentFence:String\(intent.fencingToken\),correctionArtifactUri:/);
 assert.match(code,/previousVerifierRunId:reconciling.child_run_id,verifierCorrectionArtifactUri:/);
 assert.match(code,/predecessor requested no commands/);
 assert.match(code,/Verifier reconciliation requires execute and exact correction alone, without watch/);
 assert.match(code,/a.id!==reconciling\?\.id/);
 assert.doesNotMatch(code,/resumeWorkflowRunFromCheckpoint|retryFailedWorkflowRun/);
});

test('historical write failures cannot become current read-only verifier prerequisites',()=>{
 const prior='Requested commands require successful governed file-write prerequisites.';
 const text=historicalRecoveryDiagnostic(prior,true);
 assert.ok(text.includes(prior));
 assert.match(text,/HISTORICAL original-run diagnostic/);
 assert.match(text,/not a current command rejection/);
 assert.match(text,/Request fresh policy-allowed read-only verification commands/);
 assert.match(text,/Do not create a source write/);
 assert.match(source(),/source.blocker=historicalRecoveryDiagnostic\(source.blocker,role==='verifier'\|\|Boolean\(assessing\)\)/);
});

test("approved legacy recovery projects separate current baselines without rewriting original runs",()=>{
  const code=source();
  assert.match(code,/if\(!source\.metadata\?\.acceptanceContract&&legacyAvailable\)/u);
  assert.match(code,/const legacy=await getLegacyRecoveryEnrollment\(source\.id\)/u);
  assert.match(code,/legacyEnrollmentId:legacy\.enrollmentId,provider_override:legacy\.provider,model_tier_override:legacy\.modelTier/u);
  assert.match(code,/legacyEnrollmentId:data\.sources\.get\(family\.sourceRunId\)\?\.legacyEnrollmentId/u);
  assert.match(code,/enrollmentMode:'legacy-current-baseline'/u);
  assert.match(code,/\.\.\.inheritedCodexOrigin\(source\.metadata\)/u);
  assert.match(code,/if\(options\.execute\|\|options\.watch\|\|options\.requestHelp\)throw new Error\('Legacy enrollment cannot dispatch or watch'\)/u);
  assert.match(code,/plans\.length>3/u);
  assert.doesNotMatch(code,/update workflow_runs/iu);
});

test("explicit no-effect reconciliation never selects a new family or drops unrelated overlap holds",()=>{
  const code=source();
  assert.match(code,/activeRunIds:family\.activeRunIds\.filter\(id=>id!==`reservation:\$\{reservationId\}`\)/u);
  assert.match(code,/plan\.repairs=plan\.repairs\.filter\(p=>p\.family\.familyId===resuming\.family_id&&p\.lane===resuming\.lane\);plan\.verifiers=\[\]/u);
  assert.match(code,/reconcileUnstartedCoordinatorReservation\(resuming\.id\)/u);
  assert.match(code,/options\.resumeReservation&&\(!options\.execute\|\|options\.watch\|\|options\.enrollLegacy\|\|options\.requestHelp\)/u);
});

test('resuming a proven-unstarted claim excludes only that reservation from unchanged-attempt inhibition',()=>{
 const f:QueueCoordinatorFamily={familyId:'family',sourceRunId:'source',projectId:'project',projectRootUri:'/synthetic',canonical:true,
  activeRunIds:['reservation:target'],pendingApprovalIds:[],fileScopes:['src/feature.ts'],failureFingerprint:'same',priorFingerprint:'same',repairDepth:0,verificationReady:false,originalAcceptancePresent:true,sourceEvidenceReady:true,blocker:'local source correction'};
 const a={id:'target',family_id:'family',role:'repair',fingerprint:'same'};
 const resumed=prepareUnstartedResumeProjection(f,[a],'target');
 assert.equal(planQueueCoordinator([resumed]).repairs.length,1);
 assert.equal(f.activeRunIds.length,1,'Original snapshot is not rewritten');
 assert.equal(planQueueCoordinator([prepareUnstartedResumeProjection(f,[a,{...a,id:'prior'}],'target')]).repairs.length,0,'Other unchanged attempts still inhibit');
 assert.equal(planQueueCoordinator([prepareUnstartedResumeProjection({...f,activeRunIds:[...f.activeRunIds,'real-active']},[a],'target')]).repairs.length,0,'Real family activity still inhibits');
 assert.equal(planQueueCoordinator([resumed,{...f,familyId:'other',activeRunIds:['other-active']}]).repairs.length,0,'Other active overlapping families still inhibit');
});

test("technical blockers run through autonomous Partner actors, never an originating-chat help outbox",()=>{
  const code=source();
  assert.match(code,/\.option\('--autonomous-recovery'/);assert.match(code,/options.autonomousRecovery&&\(!options.execute\|\|!options.manageSelfRepair/);
  assert.match(code,/partnerCanInvestigate\(f,data.sources.get\(f.sourceRunId\)!,reasons.get\(f.familyId\)!\)/);
  assert.match(code,/execute\?await runPartnerActors\(actorCandidates,data.sources,actorAdapter,\{onSettled,shouldStop,maxActors:admission\.newItemLimit\}\):\[\]/);
  assert.doesNotMatch(code,/requestQueuePartnerHelp|deliverRunNotifications/);
  assert.match(code,/originating-chat technical handoffs are disabled/);
  assert.match(code,/technicalRecoveryOwner:'queue-partner' as const,technicalHandoff:'disabled' as const/);
});

test('all held continuations remain Partner-owned without bypassing their exact gates',()=>{
 for(const reason of ['queued coordinator lineage cannot be leased; exact assignment reconciliation required',
  'Product ownership is routed to canonical project synthetic','pending approval','family already active',
  'external proof or authority required','missing source evidence or original acceptance',
  'same repaired revision already assessed; explicit reconciliation required',
  'dependency execution remains Partner-owned; terminal history requires governed reconciliation',
  'unchanged failure suppressed','Partner coordinator code defect']){
   const next=heldFamilyNextAction(reason,[]);
   assert.match(next,/^Partner owns this continuation:/,reason);
   assert.doesNotMatch(next,/hand.*back|Codex|originating chat/iu,reason);
 }
 assert.match(heldFamilyNextAction('pending approval',[]),/human decision.*only the governed action/);
 assert.match(heldFamilyNextAction('external proof or authority required',[]),/offline tests cannot substitute/);
 const code=source();
 assert.doesNotMatch(code,/terminal attempts require Codex reconciliation|Codex handback/);
 assert.match(code,/dependency execution remains Partner-owned; terminal history requires governed reconciliation/);
});

test('Partner uses its agents for framework defects and retains exact approval and acceptance boundaries',()=>{
 const card=readFileSync(new URL('../../../agents/operations/queue-partner.yaml',import.meta.url),'utf8');
 assert.match(card,/Never hand technical work back to Codex or the originating chat,/);
 assert.match(card,/including code defects in Partner or its framework/);
 assert.match(card,/agents for diagnosis, repairs and independent verification/);
 assert.match(card,/without transferring the technical work or bypassing a gate/);
 assert.match(card,/Never approve your own permission expansion/);
});

test('idle ordinary ticks discover only existing exact assessment authority and reenter explicit bounded mode',()=>{
 const code=source();
 assert.match(code,/execute&&!assessment&&!resumeReservation&&!reconcileVerifier&&!requestHelp&&!plan.repairs.length&&!plan.verifiers.length/);
 assert.match(code,/discoverAuthorizedAssessment\(\{reviewedRoots:projectRoots,enrolledFamilies:enrolled,families:data.families,assignments:data.assignments\}\)/);
 assert.match(code,/return tick\(ctx,execute,projectRoots,enrolled,false,undefined,undefined,authorized,onSettled,shouldStop,autonomousRecovery,sourceRunIds\)/,'An exact assessment must retain the current canary restriction');
});

test('recovered proposals remain visible exact permission boundaries without technical handoff or automatic enrollment',()=>{
 const code=source();
 assert.match(code,/proposal\?'scope-authorization-required':'held'/);
 assert.match(code,/requiresPermission:family.pendingApprovalIds.length>0\|\|narrative.requiresPermission===true/);
 assert.match(code,/requiresPermission:Boolean\(proposal\)/);
 assert.match(code,/Review the recovered source paths and approve\/reject a fresh scoped baseline; no historical approval inherited/);
});

test("explicit-root mode freezes startup inventory and neither mode closes original runs", () => {
  const code=source();
  assert.match(code,/const enrolled=new Set\(options.allQueuedProjects\?\[\]:\(await snapshot\(projectRoots\)\)\.families\.map\(f=>f\.familyId\)\)/u);
  assert.match(code,/data\.families\.filter\(f=>enrolled\.has\(f\.familyId\)/u);
  for(const mutation of ["dismissFailedWorkflowRun(","supersedeWorkflowRun(","completeWorkflowTask(","retryFailedWorkflowRun(","replayWorkflowRun("]) {
    assert.ok(!code.includes(mutation),`Coordinator must not silently mutate original acceptance: ${mutation}`);
  }
});

test("coordinator binds original provider tier and strict execution allowlist",()=>{
  const code=source();
  assert.match(code,/providerOverride:source\.provider_override,modelTierOverride:source\.model_tier_override/u);
  assert.match(code,/providerIds:\[source\.provider_override\],strictProviderIds:\[source\.provider_override\]/u);
  assert.match(code,/recoverExpiredLeases:false/u);
  assert.match(code,/runId:child\.runId/u);
  assert.match(code,/Original provider and tier are not explicitly bound/u);
});

test("repair records immutable baseline before child creation and execution without prehash acceptance",()=>{
  const code=source();
  const baseline=code.indexOf("await captureRepairRevisionBaseline(claim)");
  assert.ok(baseline>0&&baseline<code.indexOf("const child=await createWorkflowRun"));
  assert.ok(baseline<code.indexOf("await runWorkerOnce"));
  assert.match(code,/acceptanceRequirements:candidate\|\|assessing\?\{sourcePaths:family\.fileScopes,subjectHash:candidate\?\.repairedHash\?\?frozen\.subjectHash,/u);
  assert.match(code,/deliverables:frozen\.deliverables\.map\(\(d:any\)=>\(\{\.\.\.d,status:'pending',receipts:\{\},gaps:\[\]\}\)\)\}:undefined/u);
  assert.doesNotMatch(code,/subjectHash:frozen\.subjectHash/u);
  assert.match(code,/originalAcceptanceDigest:acceptanceDigest\(frozen\)/u);
});

test("independent verifier has four original gates and no source write permission",()=>{
  const code=source();
  const helper=code.slice(code.indexOf("function createRevisionVerificationWorkflow"),code.indexOf("/** Original execution-scope"));
  for(const gate of ["implementation","verification","packaging","supervision"])assert.ok(helper.includes(`['${gate}'`));
  assert.match(helper,/No source writes, changed requirements, real user actions, or invented native\/external proof/u);
  assert.match(code,/allowed_write_paths:role==='verifier'\|\|assessing\?\[\]:family\.fileScopes/u);
  assert.match(code,/const workflow=role==='verifier'\|\|assessing\?createRevisionVerificationWorkflow\(\):createAgentTaskWorkflow\(agent\)/u);
  assert.match(code,/const candidate=role==='verifier'\?data\.revisionCandidates\.get\(source\.id\):undefined/u);
});

test('explicit history assessments cannot dispatch repairs, watch, or reuse terminal acceptance',()=>{
 const code=source();
 assert.match(code,/if\(role==='repair'&&!assessing\)/);
 assert.match(code,/reserveHistoryPreservingAssessment\(\{assignmentId:assessing.id/);
 assert.match(code,/provenanceKind:'authorized-current-baseline-assessment'/);
 assert.match(code,/Assessment requires exact authorization and execute alone/);
 assert.match(code,/family.activeRunIds.length\|\|family.pendingApprovalIds.length/);
 assert.match(code,/if\(assessing\)\{[\s\S]*?plan.repairs=\[\];plan.verifiers=\[\]/);
 assert.match(code,/source:assessing\?'queue-coordinator-assessment'/);
 assert.doesNotMatch(code,/retryFailedWorkflowRun|resumeWorkflowRunFromCheckpoint|update workflow_runs/);
});

test('context batching keeps final-source evidence and every acceptance gate mandatory',()=>{
 const code=source();
 assert.match(code,/batch independent exact file reads and searches into one structured request/);
 assert.match(code,/Fresh verification after the final source change, original acceptance gates and policy checks remain mandatory/);
 assert.match(code,/efficiency never permits stale evidence or skipped tests/);
 assert.match(code,/workflow,task:assessing\?executionTask.replace/);
});

test("post-repair hash change schedules separate verification and not repair completion",()=>{
  const code=source();
  assert.match(code,/candidate\?\.repairedHash\?\?contract\.subjectHash/u);
  assert.match(code,/let verificationReady=Boolean\(ready&&candidate\)/u);
  assert.match(code,/if\(role==='repair'\)\{await recordRepairRevisionCandidate\(claim\);return \{state:'held'/u);
  assert.match(code,/await attestRepairedRevision\(claim,candidate!\.id,child\.runId\)/u);
  assert.match(code,/if\(state==='verified'\)await promoteVerifiedQueuePartnerRemedy\(claim\)/u);
  assert.match(code,/verifyRepairedRevisionAttestation\(source\.id,candidate\.repairedHash\)/u);
  assert.match(code,/if\(options\.initialize\)\{await initializeQueueCoordinator\(\);await initializeRepairedRevisions\(\);\}/u);
  assert.doesNotMatch(code,/Automatic repair dispatch is not enabled/u);
  assert.match(code,/execute\?await executeQueueCoordinatorPlan\(plan,/u);
});

test("unchanged assessed revision is held before planning or intent acquisition",()=>{
  const code=source();
  const holds=code.indexOf("const verificationHolds=");
  assert.ok(holds>0&&holds<code.indexOf("const plan=planQueueCoordinator"));
  assert.ok(holds<code.indexOf("await acquireWorkIntent"));
  assert.match(code,/a\.role==='verifier'&&a\.fingerprint===f\.failureFingerprint&&\['held','failed','verified'\]\.includes\(a\.state\)/u);
  assert.match(code,/!verificationHolds\.some\(h=>h\.familyId===f\.familyId\)/u);
  assert.match(code,/plan\.holds\.push\(\.\.\.verificationHolds\)/u);
});

test('historical repair candidate cannot override a newly authorized current-source contract',async()=>{
 const {acceptanceDigest}=await import('../../../packages/storage/src/acceptance.js');
 const before={subjectHash:'old',deliverables:[{description:'Preserve every original requirement'}]};
 const after={...before,subjectHash:'current'};
 const candidate={originalContractDigest:acceptanceDigest(before)} as any;
 assert.equal(candidateMatchesCurrentContract(candidate,before),true);
 assert.equal(candidateMatchesCurrentContract(candidate,after),false);
 assert.equal(candidateMatchesCurrentContract({...candidate,originalContractDigest:'tampered'},before),false);
});
