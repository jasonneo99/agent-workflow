import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import type {Client} from 'pg';
import {withClient} from './client.js';
import {providerAvailabilitySchemaSql,claimProviderAvailabilityOnClient,recordProviderFailureOnClient,recordProviderAvailableOnClient,renewProviderProbeOnClient} from './provider-availability.js';

async function fixture(body:(tx:<T>(fn:(c:Client)=>Promise<T>)=>Promise<T>)=>Promise<void>){
 const schema='provider_availability_'+randomUUID().replaceAll('-','');
 await withClient(c=>c.query(`create schema ${schema}`));
 const tx=async<T>(fn:(c:Client)=>Promise<T>)=>withClient(async c=>{
  await c.query('begin');try{await c.query(`set local search_path to ${schema},public`);const result=await fn(c);await c.query('commit');return result;}
  catch(error){await c.query('rollback');throw error;}
 });
 try{await tx(c=>c.query(providerAvailabilitySchemaSql));await body(tx);}
 finally{await withClient(c=>c.query(`drop schema ${schema} cascade`));}
}
test('separate workers share quota cooldown and stale success cannot reopen an account',()=>fixture(async tx=>{
 const key='a'.repeat(64),old=await tx(c=>claimProviderAvailabilityOnClient(c,key));assert.equal(old.allowed,true);
 await tx(c=>recordProviderFailureOnClient(c,key,'account_quota',60_000,3));
 assert.equal((await tx(c=>claimProviderAvailabilityOnClient(c,key))).allowed,false);
 assert.equal(await tx(c=>recordProviderAvailableOnClient(c,old)),false);
 assert.equal((await tx(c=>claimProviderAvailabilityOnClient(c,key))).failureKind,'account_quota');
}));
test('cooldown expiry admits one fenced probe across concurrent connections',()=>fixture(async tx=>{
 const key='b'.repeat(64);await tx(c=>recordProviderFailureOnClient(c,key,'account_quota',60_000,3));
 await tx(c=>c.query("update provider_availability set retry_at=clock_timestamp()-interval '1 second' where scope_key=$1",[key]));
 const pids=new Set<number>();
 const claims=await Promise.all([1,2].map(()=>tx(async c=>{pids.add((await c.query('select pg_backend_pid() pid')).rows[0].pid);return claimProviderAvailabilityOnClient(c,key);})));
 assert.equal(pids.size,2);assert.equal(claims.filter(c=>c.allowed).length,1);
 const probe=claims.find(c=>c.allowed)!;assert.ok(probe.probeToken);
 assert.equal(await tx(c=>renewProviderProbeOnClient(c,probe)),true);
 assert.equal(await tx(c=>recordProviderAvailableOnClient(c,probe)),true);
 assert.equal(await tx(c=>renewProviderProbeOnClient(c,probe)),false);
 assert.equal((await tx(c=>claimProviderAvailabilityOnClient(c,key))).allowed,true);
}));
test('transient failure threshold is durable and unrelated accounts remain eligible',()=>fixture(async tx=>{
 const key='c'.repeat(64);await tx(c=>recordProviderFailureOnClient(c,key,'provider_outage',60_000,2));
 assert.equal((await tx(c=>claimProviderAvailabilityOnClient(c,key))).allowed,true);
 await tx(c=>recordProviderFailureOnClient(c,key,'rate_limited',60_000,2));
 assert.equal((await tx(c=>claimProviderAvailabilityOnClient(c,key))).allowed,false);
 assert.equal((await tx(c=>claimProviderAvailabilityOnClient(c,'d'.repeat(64)))).allowed,true);
}));
test('expired recovery probe cannot reopen provider availability',()=>fixture(async tx=>{
 const key='e'.repeat(64);await tx(c=>recordProviderFailureOnClient(c,key,'account_quota',60_000,3));
 await tx(c=>c.query("update provider_availability set retry_at=clock_timestamp()-interval '1 second' where scope_key=$1",[key]));
 const probe=await tx(c=>claimProviderAvailabilityOnClient(c,key));assert.ok(probe.probeToken);
 await tx(c=>c.query("update provider_availability set probe_expires_at=clock_timestamp()-interval '1 second' where scope_key=$1",[key]));
 assert.equal(await tx(c=>recordProviderAvailableOnClient(c,probe)),false);
 assert.equal(await tx(c=>renewProviderProbeOnClient(c,probe)),false);
 const next=await tx(c=>claimProviderAvailabilityOnClient(c,key));assert.equal(next.allowed,true);assert.notEqual(next.probeToken,probe.probeToken);
}));
