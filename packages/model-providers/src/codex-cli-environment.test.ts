import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {codexCliChildEnvironment} from './codex-cli-environment.js';
import {createCodexCliRunner} from './codex-cli.js';

const forbidden = ['DATABASE_URL', 'TEST_DATABASE_URL', 'PGPASSWORD', 'REDIS_URL',
  'OBJECT_STORAGE_ENDPOINT', 'OBJECT_STORAGE_ACCESS_KEY', 'OBJECT_STORAGE_SECRET_KEY',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'OPENAI_API_KEY',
  'OPENAI_ADMIN_KEY', 'ANTHROPIC_API_KEY', 'AGENTFLOW_SIGNING_SECRET', 'GITHUB_TOKEN',
  'FUTURE_SERVICE_CREDENTIAL', 'HTTP_PROXY', 'HTTPS_PROXY', 'OPENAI_BASE_URL', 'NODE_OPTIONS'];

test('Codex child env is an explicit platform/auth allowlist, including unknown future secrets', () => {
  const parent = Object.fromEntries(forbidden.map(key => [key, 'synthetic-marker']));
  Object.assign(parent, {PATH: '/synthetic/bin', HOME: '/synthetic/home', CODEX_HOME: '/synthetic/codex',
    TMPDIR: '/synthetic/tmp', LANG: 'C.UTF-8', NO_COLOR: '0', SystemRoot: 'C:\\Windows',
    USERPROFILE: 'C:\\SyntheticHome', __CF_USER_TEXT_ENCODING: 'synthetic-encoding'});
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    const env = codexCliChildEnvironment(parent, platform);
    for (const key of forbidden) assert.equal(Object.hasOwn(env, key), false, key);
    assert.equal(env.PATH, parent.PATH); assert.equal(env.HOME, parent.HOME);
    assert.equal(env.CODEX_HOME, parent.CODEX_HOME); assert.equal(env.NO_COLOR, '1');
    assert.equal(env.SystemRoot, platform === 'win32' ? parent.SystemRoot : undefined);
    assert.equal(env.USERPROFILE, platform === 'win32' ? parent.USERPROFILE : undefined);
    assert.equal(env.__CF_USER_TEXT_ENCODING, platform === 'darwin' ? parent.__CF_USER_TEXT_ENCODING : undefined);
  }
});

test('Windows spellings produce one canonical environment key without opening other names', () => {
  const env = codexCliChildEnvironment({Path: 'synthetic-path', SYSTEMROOT: 'synthetic-root',
    userprofile: 'synthetic-home', APPDATA: 'synthetic-appdata', localappdata: 'synthetic-local',
    comspec: 'synthetic-shell', WINDIR: 'synthetic-windir', PATHEXT: '.EXE;.CMD', future_password: 'marker'}, 'win32');
  assert.deepEqual(env, {NO_COLOR: '1', PATH: 'synthetic-path', SystemRoot: 'synthetic-root',
    WINDIR: 'synthetic-windir', ComSpec: 'synthetic-shell', PATHEXT: '.EXE;.CMD',
    USERPROFILE: 'synthetic-home', APPDATA: 'synthetic-appdata', LOCALAPPDATA: 'synthetic-local'});
});

async function withEnv(values: Record<string,string|undefined>, action: () => Promise<void>): Promise<void> {
  const previous = new Map(Object.keys(values).map(key => [key,process.env[key]]));
  try {for(const [key,value] of Object.entries(values)){if(value===undefined)delete process.env[key];else process.env[key]=value;}await action();}
  finally {for(const [key,value] of previous){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
}

async function fixture(body: (dir:string) => string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'codex-child-env-'));
  const binary = path.join(dir,'fake-codex.mjs');
  await fs.writeFile(binary,'#!/usr/bin/env node\n'+body(dir)+'\n',{mode:0o700});
  await fs.mkdir(path.join(dir,'home'));await fs.mkdir(path.join(dir,'codex-home'));
  await fs.writeFile(path.join(dir,'codex-home','synthetic-auth-location.json'),'{}');
  const env:Record<string,string|undefined>={CODEX_CLI_BIN:binary,AGENTFLOW_CODEX_SESSION_REUSE:'0',
    AGENTFLOW_CODEX_CLI_CONCURRENCY:'1',AGENTFLOW_EGRESS_LOG_DIR:dir,
    HOME:path.join(dir,'home'),CODEX_HOME:path.join(dir,'codex-home'),TMPDIR:dir,TMP:dir,TEMP:dir};
  return {dir,env,close:()=>fs.rm(dir,{recursive:true,force:true})};
}

test('actual login/exec spawns retain auth locations and omit storage, runtime and future credentials',
  {skip:process.platform==='win32'},async()=>{
  const f=await fixture(dir=>`
import fs from 'node:fs';
import path from 'node:path';
const args=process.argv.slice(2),keys=${JSON.stringify(forbidden)};
const report={present:Object.fromEntries(keys.map(key=>[key,Object.hasOwn(process.env,key)])),
 home:process.env.HOME,codexHome:process.env.CODEX_HOME,pathPresent:Boolean(process.env.PATH),
 authLocationReadable:fs.existsSync(path.join(process.env.CODEX_HOME,'synthetic-auth-location.json'))};
fs.writeFileSync(${JSON.stringify(path.join(dir,'report'))}+(args[0]==='login'?'.login':'.exec'),JSON.stringify(report));
if(args[0]==='login'){console.log('Logged in using ChatGPT');}
else {const output=args[args.indexOf('--output-last-message')+1];fs.writeFileSync(output,'{"summary":"synthetic complete"}');
console.log('{"type":"thread.started","thread_id":"12345678-1234-1234-1234-123456789abc"}');console.log('{"type":"turn.completed"}');}
`);
  try {
    const injected=Object.fromEntries(forbidden.filter(key=>key!=='NODE_OPTIONS').map(key=>[key,'synthetic-marker']));
    // NODE_OPTIONS is covered by the pure boundary test; do not inject an active
    // Node option into this test's own child interpreter before the boundary.
    await withEnv({...f.env,...injected},async()=>{
      const runner=createCodexCliRunner();assert.match(await runner.authStatus(),/Logged in using ChatGPT/);
      assert.equal((await runner.execute({prompt:'synthetic prompt',schema:{type:'object'},model:'synthetic-model'})).output,'{"summary":"synthetic complete"}');
      for(const mode of ['login','exec']){
        const observed=JSON.parse(await fs.readFile(path.join(f.dir,'report.'+mode),'utf8'));
        for(const key of forbidden)assert.equal(observed.present[key],false,key);
        assert.equal(observed.home,f.env.HOME);assert.equal(observed.codexHome,f.env.CODEX_HOME);
        assert.equal(observed.pathPresent,true);assert.equal(observed.authLocationReadable,true);
      }
    });
  }finally{await f.close();}
});

async function waitForPid(file:string):Promise<number>{
  for(let index=0;index<200;index++){try{return Number(await fs.readFile(file,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}await delay(10);}
  throw Error('Trusted fake CLI did not start within the bounded fixture wait');
}
function assertAbsent(pid:number):void{assert.throws(()=>process.kill(pid,0),(error:unknown)=>(error as NodeJS.ErrnoException).code==='ESRCH');}

for(const mode of ['abort','timeout'] as const){
  test('scrubbed actual CLI spawn remains stoppable on '+mode,{skip:process.platform==='win32',timeout:15000},async()=>{
    const f=await fixture(dir=>`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(path.join(dir,'pid'))},String(process.pid));setInterval(()=>{},1000);`);
    try{await withEnv({...f.env,CODEX_CLI_TIMEOUT_MS:'5000'},async()=>{
      const controller=new AbortController();
      const execution=createCodexCliRunner().execute({prompt:'synthetic wait',schema:{type:'object'},abortSignal:controller.signal});
      const rejection=assert.rejects(execution,(error:unknown)=>(error as {code?:string}).code==='CODEX_CLI_TIMEOUT');
      const pid=await waitForPid(path.join(f.dir,'pid'));if(mode==='abort')controller.abort();
      await rejection;assertAbsent(pid);
    });}finally{await f.close();}
  });
}
