import type {Client} from 'pg';
import {activeQueueRunPredicateSql} from './queue-lineage.js';

/** Negative admission check only. Reuse the queue's existing visibility rules
 * for ONE exact source, not a visible descendant or another project identity.
 * An active display row never grants execution; all ordinary guards still run.
 */
export async function activeQueueSourceOnClient(c:Client,sourceRunId:string):Promise<boolean>{
 const row=(await c.query(`select exists(select 1 from workflow_runs source
  where source.id=$1 and ${activeQueueRunPredicateSql('source')}) active`,[sourceRunId])).rows[0];
 return row?.active===true;
}
