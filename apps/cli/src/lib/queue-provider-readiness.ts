import {getProviderReadiness,selectModelRoute} from '../../../../packages/model-providers/src/routing.js';
import type {ProjectConfig} from '../../../../packages/agent-registry/src/schemas.js';

/** Readiness is admission evidence; the executor still validates its own route. */
export async function queueProviderReadiness(project:ProjectConfig,agentId:string){
 const route=await selectModelRoute({workflowId:'partner-recovery',agentId,stageId:'recover',compiledBrief:'',modelTier:'standard',projectConfig:project});
 if(route.providerId==='mock')return {ready:false,reason:'No live execution provider is ready. Restore provider availability before recovery dispatch.'};
 const readiness=await getProviderReadiness(route.providerId);
 return readiness.ready
  ?{ready:true,reason:'Current source, policy and execution provider are ready.'}
  :{ready:false,reason:`Execution provider ${route.providerId} is unavailable; repair its configuration or authentication before dispatch.`};
}
