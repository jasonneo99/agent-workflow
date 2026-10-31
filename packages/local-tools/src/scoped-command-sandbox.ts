import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Optional command-write containment, independent of command allowlisting.
 * Source changes must go through governed file tools, not a formatter/script
 * escaping a narrow reservation. No unsupported-platform unsandboxed fallback.
 */
export async function prepareScopedCommandSandbox(input:{enabled:boolean;argv:string[];env:NodeJS.ProcessEnv;platform?:NodeJS.Platform;nativePty?:boolean}){
 if(!input.enabled)return {argv:input.argv,env:input.env,cleanup:async()=>{}};
 if((input.platform??process.platform)!=='darwin')throw Error('Scoped command write isolation is unavailable on this host; no unsandboxed command was started.');
 await fs.access('/usr/bin/sandbox-exec',constants.X_OK);
 const scratch=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'agentflow-command-')));
 // The kernel grants com.apple.sandbox.pty only for PTYs allocated by this
 // sandbox. Never permit writes to every existing /dev/ttys device.
 const pty=input.nativePty===true?'(allow pseudo-tty)(allow file-write-data (literal "/dev/ptmx"))(allow file-write-data (require-all (regex #"^/dev/ttys[0-9]+$") (extension "com.apple.sandbox.pty")))':'';
 const profile=`(version 1)(allow default)(deny file-write*)(allow file-write* (subpath ${JSON.stringify(scratch)}))(allow file-write-data (literal "/dev/null"))${pty}`;
 return {
  argv:['/usr/bin/sandbox-exec','-p',profile,...input.argv],
  env:{...input.env,TMPDIR:scratch,TMP:scratch,TEMP:scratch,XDG_CACHE_HOME:path.join(scratch,'cache'),PYTHONDONTWRITEBYTECODE:'1',PYTHONPYCACHEPREFIX:path.join(scratch,'pycache')},
  cleanup:async()=>{await fs.rm(scratch,{recursive:true,force:true});}
 };
}
