import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {loadProjectConfig} from './loaders.js';
test('ignored local runtime profiles merge without replacing existing selectors, commands or source policy',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'local-pipeline-')));try{
  await fs.mkdir(path.join(root,'.agent-workflow'));
  const base='project: {name: Portable project}\nactions:\n  allowed_commands: [node --version]\n  allowed_write_paths: [src/**]\n';
  await fs.writeFile(path.join(root,'.agent-workflow/project.yaml'),base);
  await fs.writeFile(path.join(root,'.agent-workflow/project.local.yaml'),'execution:\n  pipeline: {required: true}\nactions:\n  allowed_commands: [node --version, python3 --version]\n');
  const config=await loadProjectConfig(root,{filePath:path.join(root,'absent.yaml')});
  assert.equal(config.execution.pipeline?.required,true);assert.deepEqual(config.actions.allowed_commands,['node --version','python3 --version']);assert.deepEqual(config.actions.allowed_write_paths,['src/**']);
  assert.equal(await fs.readFile(path.join(root,'.agent-workflow/project.yaml'),'utf8'),base);
  await fs.unlink(path.join(root,'.agent-workflow/project.local.yaml'));await fs.symlink(path.join(root,'.agent-workflow/project.yaml'),path.join(root,'.agent-workflow/project.local.yaml'));
  await assert.rejects(loadProjectConfig(root,{filePath:path.join(root,'absent.yaml')}),/regular owned/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
