import fs from 'node:fs/promises';
import path from 'node:path';
import {withClient} from '../../../../packages/storage/src/client.js';

type ProjectLocation={id:string;root:string};
interface ProjectLookup {
 realpath(root:string):Promise<string>;
 lookup(root:string):Promise<ProjectLocation[]>;
}
const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu;
const defaults:ProjectLookup={realpath:fs.realpath,lookup:root=>withClient(async c=>(await c.query(
 "select distinct p.id::text id,p.root_uri root from projects p join project_identity_locations l on l.project_id=p.id and l.identity_id=p.id and l.kind='canonical' where p.root_uri=$1",[root])).rows)};

/** An intent is a lock, not permission. Paths and IDs must use the same lock
 * namespace; a parent path, historical alias or symlink never selects a child. */
export async function resolveWorkIntentProject(value:string,hooks:ProjectLookup=defaults):Promise<string>{
 if(uuid.test(value))return value.toLowerCase();
 const root=path.resolve(value);
 if(/(^|\/)(vendor|node_modules)(\/|$)/iu.test(root))throw Error('Use an exact registered canonical project ID, not a vendor or dependency path');
 if(await hooks.realpath(root)!==root)throw Error('Work-intent project aliases are not canonical; use its registered project ID');
 const rows=await hooks.lookup(root);
 if(rows.length!==1||rows[0]!.root!==root||!uuid.test(rows[0]!.id))throw Error('Exact canonical project registration required for a work-intent path');
 return rows[0]!.id.toLowerCase();
}
