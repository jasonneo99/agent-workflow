import {randomUUID} from 'node:crypto';
import type {Client} from 'pg';
import {databaseUrl,withClient} from './client.js';

/** Scheduling observations only. Availability never grants provider/data access. */
export const providerAvailabilitySchemaSql=`create table if not exists provider_availability (
 scope_key text primary key, generation bigint not null default 0,
 failures integer not null default 0, failure_kind text,
 retry_at timestamptz, probe_token uuid, probe_expires_at timestamptz,
 updated_at timestamptz not null default clock_timestamp()
);`;
export interface ProviderAvailabilityClaim {key:string;generation:string;probeToken:string|null;allowed:boolean;failureKind:string|null}
function validKey(key:string){if(!/^[a-f0-9]{64}$/u.test(key))throw Error('Invalid provider availability scope');}

/** Caller owns a transaction. Row locking admits at most one recovery probe. */
export async function claimProviderAvailabilityOnClient(c:Client,key:string):Promise<ProviderAvailabilityClaim>{
 validKey(key);
 await c.query('insert into provider_availability(scope_key) values($1) on conflict do nothing',[key]);
 const row=(await c.query(`select generation::text, failure_kind,
   retry_at is not null as recovering, retry_at>clock_timestamp() as cooling,
   probe_expires_at>clock_timestamp() as probing
   from provider_availability where scope_key=$1 for update`,[key])).rows[0];
 const result={key,generation:row.generation,probeToken:null,failureKind:row.failure_kind};
 if(row.cooling||row.probing)return {...result,allowed:false};
 if(!row.recovering)return {...result,allowed:true};
 const token=randomUUID();
 const updated=await c.query(`update provider_availability set generation=generation+1,probe_token=$2,
   probe_expires_at=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp()
   where scope_key=$1 returning generation::text`,[key,token]);
 return {...result,allowed:true,generation:updated.rows[0].generation,probeToken:token};
}

export async function recordProviderAvailableOnClient(c:Client,claim:ProviderAvailabilityClaim):Promise<boolean>{
 validKey(claim.key);
 const result=await c.query(`update provider_availability set generation=generation+1,failures=0,
   failure_kind=null,retry_at=null,probe_token=null,probe_expires_at=null,updated_at=clock_timestamp()
   where scope_key=$1 and generation=$2::bigint and probe_token is not distinct from $3::uuid
     and ($3::uuid is null or probe_expires_at>clock_timestamp())`,
 [claim.key,claim.generation,claim.probeToken]);
 return result.rowCount===1;
}

export async function renewProviderProbeOnClient(c:Client,claim:ProviderAvailabilityClaim):Promise<boolean>{
 validKey(claim.key);if(!claim.probeToken)return true;
 return (await c.query(`update provider_availability set probe_expires_at=clock_timestamp()+interval '60 seconds'
   where scope_key=$1 and generation=$2::bigint and probe_token=$3::uuid
     and probe_expires_at>clock_timestamp()`,[claim.key,claim.generation,claim.probeToken])).rowCount===1;
}

export async function recordProviderFailureOnClient(c:Client,key:string,kind:string,cooldownMs:number,threshold:number):Promise<void>{
 validKey(key);if(!['account_quota','provider_outage','rate_limited'].includes(kind))return;
 if(!Number.isFinite(cooldownMs)||cooldownMs<1000||cooldownMs>3_600_000||!Number.isInteger(threshold)||threshold<1||threshold>20)throw Error('Invalid provider recovery limits');
 await c.query(`insert into provider_availability(scope_key,failures,failure_kind,retry_at,generation)
   values($1,1,$2,case when $2='account_quota' or $4=1 then clock_timestamp()+($3::int*interval '1 millisecond') else null end,1)
   on conflict(scope_key) do update set failures=provider_availability.failures+1,
   generation=provider_availability.generation+1,failure_kind=excluded.failure_kind,
   retry_at=case when $2='account_quota' or provider_availability.failures+1 >= $4
     then greatest(provider_availability.retry_at,clock_timestamp()+($3::int*interval '1 millisecond'))
     else provider_availability.retry_at end,
   probe_token=null,probe_expires_at=null,updated_at=clock_timestamp()`,[key,kind,cooldownMs,threshold]);
}

const initialization=new Map<string,Promise<void>>();
async function ready(){
 const key=databaseUrl();let pending=initialization.get(key);
 if(!pending){pending=withClient(async c=>{await c.query('begin');try{
  await c.query("select pg_advisory_xact_lock(hashtext('agentflow:provider-availability-schema'))");
  await c.query(providerAvailabilitySchemaSql);await c.query('commit');
 }catch(error){await c.query('rollback');throw error;}});initialization.set(key,pending);void pending.catch(()=>initialization.delete(key));}
 await pending;
}
export async function claimProviderAvailability(key:string){await ready();return withClient(async c=>{
 await c.query('begin');try{const claim=await claimProviderAvailabilityOnClient(c,key);await c.query('commit');return claim;}
 catch(error){await c.query('rollback');throw error;}
});}
export async function recordProviderAvailable(claim:ProviderAvailabilityClaim){await ready();return withClient(c=>recordProviderAvailableOnClient(c,claim));}
export async function renewProviderProbe(claim:ProviderAvailabilityClaim){await ready();return withClient(c=>renewProviderProbeOnClient(c,claim));}
export async function recordProviderFailure(key:string,kind:string,cooldownMs:number,threshold:number){await ready();return withClient(c=>recordProviderFailureOnClient(c,key,kind,cooldownMs,threshold));}
