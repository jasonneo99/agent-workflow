import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {qualificationCases,fixtureFiles} from './live-development-qualification.mjs';

test('fixed live cohort has six cases including the required baseline and five controls',()=>{
 assert.deepEqual(qualificationCases.map(c=>c.id),['baseline','bug-fix','library-cli','refactor','no-change','negative']);
 for(const spec of qualificationCases){assert(spec.writes.length);assert(spec.writes.every(f=>!f.startsWith('tests/')));assert.equal(spec.tests.length,4);}
});
test('immutable behavioral oracles distinguish genuine unchanged success from intentional failure',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'qualification-oracles-'));
 try{for(const spec of qualificationCases){const dir=path.join(root,spec.id);await fs.mkdir(dir);
  for(const [relative,body]of Object.entries(fixtureFiles(spec))){await fs.mkdir(path.dirname(path.join(dir,relative)),{recursive:true});await fs.writeFile(path.join(dir,relative),body);}
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const result=spawnSync(process.execPath,['--test','tests/behavior.test.mjs'],{cwd:dir,encoding:'utf8',env});
  assert.equal(result.status===0,spec.id==='no-change',`${spec.id}: baseline oracle must detect the requested work or explicit negative control`);
  if(spec.id==='no-change')assert.match(result.stdout,/pass 4/u);
  if(spec.id==='negative')assert.match(result.stdout,/fail 1/u);
 }}finally{await fs.rm(root,{recursive:true,force:true});}
});
