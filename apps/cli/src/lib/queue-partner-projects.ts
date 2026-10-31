import fs from 'node:fs/promises';
import path from 'node:path';
import {withClient} from '../../../../packages/storage/src/client.js';

export type PartnerProject={id:string;name:string;rootUri:string;canonical:boolean};
const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu;
/** Queue visibility is broad; a location link is never permission to write an alias. */
export async function partnerProjectAccess(project:PartnerProject,realpath:(root:string)=>Promise<string>=fs.realpath):Promise<string|null>{
 if(!uuid.test(project.id)||!project.canonical)return 'The owning project is not a canonical registration; identity links do not transfer permissions.';
 if(!path.isAbsolute(project.rootUri)||path.normalize(project.rootUri)!==project.rootUri||/(^|\/)(?:vendor|node_modules)(?:\/|$)/iu.test(project.rootUri))return 'The owning root is not a canonical local source directory.';
 try{if(await realpath(project.rootUri)!==project.rootUri)return 'The registered root is an alias; resolve its owning source before acting.';}
 catch{return 'The registered owning root is unavailable on this host; restore that exact project access.';}
 return null;
}
export async function loadPartnerProject(id:string):Promise<PartnerProject|null>{
 if(!uuid.test(id))return null;
 return withClient(async c=>(await c.query<PartnerProject>(`select p.id::text,p.name,p.root_uri as "rootUri",
 exists(select 1 from project_identity_locations l where l.project_id=p.id and l.identity_id=p.id and l.kind='canonical') canonical
 from projects p where p.id=$1::uuid`,[id])).rows[0]??null);
}
/** Re-run each watch pass, so future queued projects do not require a new watch. */
export async function discoverPartnerProjects(
 load:()=>Promise<PartnerProject[]>=()=>withClient(async c=>(await c.query<PartnerProject>(`select p.id::text,p.name,p.root_uri as "rootUri",
 exists(select 1 from project_identity_locations l where l.project_id=p.id and l.identity_id=p.id and l.kind='canonical') canonical
 from projects p where exists(select 1 from workflow_runs r where r.project_id=p.id and r.status in ('queued','leased','running','blocked','failed'))
 order by p.id limit 201`)).rows),
 check:(project:PartnerProject)=>Promise<string|null>=partnerProjectAccess
):Promise<{projects:PartnerProject[];holds:Array<{projectId:string;reason:string}>;truncated:boolean}>{
 const registered=await load(),projects:PartnerProject[]=[],holds:Array<{projectId:string;reason:string}>=[];
 // Fail closed on an incomplete discovery: do not silently pretend all projects were handled.
 if(registered.length>200)return {projects:[],holds:[{projectId:'queue',reason:'Queue project inventory exceeds 200; narrow or paginate discovery before dispatch.'}],truncated:true};
 for(const project of registered){const reason=await check(project);if(reason)holds.push({projectId:project.id,reason});else projects.push(project);}
 return {projects,holds,truncated:false};
}
