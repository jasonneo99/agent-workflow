import test from 'node:test';
import assert from 'node:assert/strict';
import {projectConfigSchema} from '../../agent-registry/src/schemas.js';
import {compileContext} from './index.js';
test('compiled worker policy distinguishes runtime capabilities without changing owning policy',async()=>{
 const project=projectConfigSchema.parse({project:{name:'Synthetic command contract'},context:{include:[]},actions:{allowed_commands:['npm *','npm test','npm run agentflow -- environments *','npm run agentflow -- repair-checkpoint *']}}),before=JSON.stringify(project);
 const brief=await compileContext({task:'Inspect source',projectDir:process.cwd(),project,workflow:{id:'fixture',name:'Fixture',lead:'fixture',stages:[]} as never,agents:[]});
 assert.match(brief,/Allowed worker commands:\n- npm \*\n- npm test/);
 assert.ok(!brief.includes('npm run agentflow -- environments *'));
 assert.ok(!brief.includes('npm run agentflow -- repair-checkpoint *'));
 assert.match(brief,/Controller commands are runtime-owned and excluded even by broad command wildcards/);
 assert.equal(JSON.stringify(project),before);
});
