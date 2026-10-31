import {withClient} from './client.js';

export interface QueuePartnerDelegationObservation {runId:string;workerAgentId:string;failureCohort:string;accepted:boolean;durationMs:number|null;modelLatencyMs:number|null;inputTokens:number|null;outputTokens:number|null;costUsd:number|null;observedAt?:string}
const minimumSamplesPerArm=20,minimumCommonCohorts=2,minimumTelemetryCoverage=.8;
const finite=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
function wilson(successes:number,total:number,bound:'lower'|'upper') {if(!total)return 0;const z=1.96,p=successes/total,z2=z*z,d=1+z2/total,m=(p+z2/(2*total))/d,e=z*Math.sqrt((p*(1-p)+z2/(4*total))/total)/d;return bound==='lower'?m-e:m+e;}
function arm(rows:QueuePartnerDelegationObservation[]){
 const measured=(key:'durationMs'|'modelLatencyMs'|'inputTokens'|'outputTokens'|'costUsd')=>rows.map(r=>r[key]).filter((v):v is number=>v!==null);
 const average=(values:number[])=>values.length?Math.round(values.reduce((a,b)=>a+b,0)/values.length*1e6)/1e6:null;
 const accepted=rows.filter(r=>r.accepted).length,tokens=rows.filter(r=>r.inputTokens!==null&&r.outputTokens!==null).map(r=>r.inputTokens!+r.outputTokens!);
 return {samples:rows.length,accepted,acceptanceRate:rows.length?accepted/rows.length:null,acceptance95:{lower:Number(wilson(accepted,rows.length,'lower').toFixed(6)),upper:Number(wilson(accepted,rows.length,'upper').toFixed(6))},
  cohorts:[...new Set(rows.map(r=>r.failureCohort))].sort(),averageDurationMs:average(measured('durationMs')),averageModelLatencyMs:average(measured('modelLatencyMs')),averageTokens:average(tokens),averageCostUsd:average(measured('costUsd')),
  coverage:{duration:rows.length?measured('durationMs').length/rows.length:0,modelLatency:rows.length?measured('modelLatencyMs').length/rows.length:0,tokens:rows.length?tokens.length/rows.length:0,cost:rows.length?measured('costUsd').length/rows.length:0},
  telemetrySamples:{duration:measured('durationMs').length,modelLatency:measured('modelLatencyMs').length,tokens:tokens.length,cost:measured('costUsd').length}};
}

/** Body-free, read-only comparison. Completion is never acceptance: accepted is
 * supplied only by an independently verified remedy-promotion record. */
export function summarizeQueuePartnerDelegationEfficiency(input:readonly QueuePartnerDelegationObservation[],now=new Date()){
 const rows=input.slice(0,1000).filter(r=>r.runId&&r.workerAgentId&&r.failureCohort&&[r.durationMs,r.modelLatencyMs,r.inputTokens,r.outputTokens,r.costUsd].every(v=>v===null||finite(v)!==null));
 const baselineRows=rows.filter(r=>r.workerAgentId==='queue-partner'),specialistRows=rows.filter(r=>r.workerAgentId!=='queue-partner');
 const baseline=arm(baselineRows),specialist=arm(specialistRows),common=baseline.cohorts.filter(c=>specialist.cohorts.includes(c));
 const powered=baseline.samples>=minimumSamplesPerArm&&specialist.samples>=minimumSamplesPerArm&&common.length>=minimumCommonCohorts;
 const outcomeImproved=powered&&specialist.acceptance95.lower>baseline.acceptance95.upper;
 const telemetryCovered=Math.min(specialist.coverage.duration,specialist.coverage.modelLatency,specialist.coverage.tokens,baseline.coverage.duration,baseline.coverage.modelLatency,baseline.coverage.tokens)>=minimumTelemetryCoverage;
 const efficiencyImproved=telemetryCovered&&specialist.averageDurationMs!==null&&baseline.averageDurationMs!==null&&specialist.averageDurationMs<baseline.averageDurationMs&&specialist.averageTokens!==null&&baseline.averageTokens!==null&&specialist.averageTokens<baseline.averageTokens;
 const costComparable=specialist.coverage.cost>=minimumTelemetryCoverage&&baseline.coverage.cost>=minimumTelemetryCoverage;
 const promotionEligible=outcomeImproved&&efficiencyImproved;
 const coverageNeeded=(value:{samples:number;telemetrySamples:Record<'duration'|'modelLatency'|'tokens'|'cost',number>})=>Object.fromEntries((['duration','modelLatency','tokens','cost'] as const).map(metric=>[metric,Math.max(0,Math.ceil(value.samples*minimumTelemetryCoverage)-value.telemetrySamples[metric])]));
 const cohortCoverage=[...new Set(rows.map(row=>row.failureCohort))].sort().map(cohort=>{const baselineSamples=baselineRows.filter(row=>row.failureCohort===cohort).length,specialistSamples=specialistRows.filter(row=>row.failureCohort===cohort).length;return {cohort,baselineSamples,specialistSamples,comparable:baselineSamples>0&&specialistSamples>0,additionalNaturalObservations:{baseline:baselineSamples?0:1,specialist:specialistSamples?0:1}};});
 const observedTimes=rows.map(row=>Date.parse(String(row.observedAt??''))).filter(Number.isFinite),latestObservedAt=observedTimes.length?new Date(Math.max(...observedTimes)).toISOString():null,stale=latestObservedAt!==null&&now.getTime()-Date.parse(latestObservedAt)>7*24*60*60*1000;
 const warnings=[...(baseline.samples?'': ['partner-direct-arm-empty']),...(specialist.samples?'': ['specialist-arm-empty']),...(stale?['instrumentation-stale']:[]),...(!telemetryCovered&&rows.length?['required-telemetry-incomplete']:[]),...(!costComparable&&rows.length?['cost-coverage-incomplete']:[])].filter(Boolean);
 return {version:1,window:'latest-1000-partner-recovery-runs',bodyFree:true,totalSamples:rows.length,baseline,specialist,commonCohorts:common,
  gate:{minimumSamplesPerArm,minimumCommonCohorts,minimumTelemetryCoverage,powered,outcomeImproved,telemetryCovered,costComparable,promotionEligible},
  routingDecision:{applied:false,recommendation:promotionEligible?'prefer-specialist':'hold-current-routing',reason:promotionEligible?'Powered matched cohorts show higher independently accepted delivery with lower measured latency and tokens.':'Insufficient powered matched evidence; no routing change is authorized.'},
  diagnostics:{status:stale?'instrumentation-stale':promotionEligible?'ready':'collecting-natural-traffic',createsRuns:false,reservesQueueCapacity:false,latestObservedAt,warnings,
   additionalNaturalObservationsForPower:{baseline:Math.max(0,minimumSamplesPerArm-baseline.samples),specialist:Math.max(0,minimumSamplesPerArm-specialist.samples),sharedCohorts:Math.max(0,minimumCommonCohorts-common.length)},
   telemetrySamplesNeeded:{baseline:coverageNeeded(baseline),specialist:coverageNeeded(specialist)},cohortCoverage},
  claims:{tokenSavings:promotionEligible?1-specialist.averageTokens!/baseline.averageTokens!:null,timeSavings:promotionEligible?1-specialist.averageDurationMs!/baseline.averageDurationMs!:null,costSavings:promotionEligible&&costComparable&&specialist.averageCostUsd!==null&&baseline.averageCostUsd!==null?1-specialist.averageCostUsd/baseline.averageCostUsd:null}};
}

export async function queuePartnerDelegationEfficiency(){return withClient(async c=>{
 const tables=(await c.query("select to_regclass('workflow_runs') runs,to_regclass('action_receipts') receipts,to_regclass('memory_nodes') memory")).rows[0];
 if(!tables?.runs||!tables?.receipts)return summarizeQueuePartnerDelegationEfficiency([]);
 const rows=(await c.query(`select r.id::text "runId",r.started_at::text "observedAt",
  case when not(r.evaluation_metadata?'partnerWorkerTeam') then 'queue-partner' else coalesce(r.evaluation_metadata->'partnerWorkerTeam'->>'workerAgentId','invalid') end "workerAgentId",
  coalesce(source.workflow_id,'unknown') "failureCohort",
  case when r.started_at is not null and r.finished_at is not null then extract(epoch from (r.finished_at-r.started_at))*1000 end "durationMs",
  exists(select 1 from memory_nodes n where n.project_id=r.project_id::text and n.metadata->>'memoryKind'='queue-partner-remedy-verification' and n.metadata->>'repairRunId'=r.id::text) accepted,
  coalesce((select sum(case when x->>'latencyMs'~'^[0-9]+(?:\\.[0-9]+)?$' then (x->>'latencyMs')::double precision end) from action_receipts a cross join lateral jsonb_array_elements(case when jsonb_typeof(a.metadata->'attempts')='array' then a.metadata->'attempts' else '[]'::jsonb end) x where a.run_id=r.id and a.action_type in ('model_route','model_route_failed')),null) "modelLatencyMs",
  coalesce((select sum(case when coalesce(x->'usage'->>'inputTokens',x->>'inputTokens')~'^[0-9]+$' then coalesce(x->'usage'->>'inputTokens',x->>'inputTokens')::double precision end) from action_receipts a cross join lateral jsonb_array_elements(case when jsonb_typeof(a.metadata->'attempts')='array' then a.metadata->'attempts' else '[]'::jsonb end) x where a.run_id=r.id and a.action_type in ('model_route','model_route_failed')),null) "inputTokens",
  coalesce((select sum(case when coalesce(x->'usage'->>'outputTokens',x->>'outputTokens')~'^[0-9]+$' then coalesce(x->'usage'->>'outputTokens',x->>'outputTokens')::double precision end) from action_receipts a cross join lateral jsonb_array_elements(case when jsonb_typeof(a.metadata->'attempts')='array' then a.metadata->'attempts' else '[]'::jsonb end) x where a.run_id=r.id and a.action_type in ('model_route','model_route_failed')),null) "outputTokens",
  coalesce((select sum(case when coalesce(x->'usage'->>'costUsd',x->>'costUsd')~'^[0-9]+(?:\\.[0-9]+)?$' then coalesce(x->'usage'->>'costUsd',x->>'costUsd')::double precision end) from action_receipts a cross join lateral jsonb_array_elements(case when jsonb_typeof(a.metadata->'attempts')='array' then a.metadata->'attempts' else '[]'::jsonb end) x where a.run_id=r.id and a.action_type in ('model_route','model_route_failed')),null) "costUsd"
  from workflow_runs r left join workflow_runs source on source.id::text=r.evaluation_metadata->>'sourceRunId' and source.project_id=r.project_id
  where r.evaluation_metadata->>'source'='queue-partner-recovery' order by r.started_at desc,r.id desc limit 1000`)).rows;
 return summarizeQueuePartnerDelegationEfficiency(rows.map(row=>({...row,durationMs:finite(row.durationMs),modelLatencyMs:finite(row.modelLatencyMs),inputTokens:finite(row.inputTokens),outputTokens:finite(row.outputTokens),costUsd:finite(row.costUsd)})));
});}
