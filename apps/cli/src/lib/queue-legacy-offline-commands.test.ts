import test from 'node:test';
import assert from 'node:assert/strict';
import {projectConfigSchema} from '../../../../packages/agent-registry/src/schemas.js';
import {legacyOfflineCommands,missingLegacyTestRecipes} from './queue-legacy-offline-commands.js';

test('syntax and diff cannot satisfy enrolled regression tests; broad grants stay bounded',()=>{
 const config=policy(['python3 *','git diff --check']);
 assert.deepEqual(missingLegacyTestRecipes(config,['src/service.py','tests/test_service.py']),['tests/test_service.py']);
 assert.deepEqual(missingLegacyTestRecipes(config,['docs/guide.md']),[]);
});
test('each test requires its own already-authorized literal recipe',()=>{
 const config=policy(['python3 -m unittest tests.test_service -v']);
 assert.deepEqual(missingLegacyTestRecipes(config,['tests/test_service.py','tests/test_other.py']),['tests/test_other.py']);
 assert.deepEqual(config.actions.allowed_commands,['python3 -m unittest tests.test_service -v']);
});

const policy=(commands:string[])=>projectConfigSchema.parse({project:{name:'synthetic'},actions:{allowed_commands:commands}});
test('broad test grants never become automatic offline discovery or npm suites',()=>{
 const result=legacyOfflineCommands(policy(['python3 *','npm test','npm run test','python3 -m unittest discover -s tests','git diff --check']),['src/service.py','tests/test_service.py']);
 assert.deepEqual(result,['python3 -m py_compile src/service.py','python3 -m py_compile tests/test_service.py','git diff --check']);
});
test('literal focused project tests remain scoped and current-policy filtered',()=>{
 const result=legacyOfflineCommands(policy(['python3 -m unittest tests.test_service -v','python3 -m unittest tests.test_other -v','python3 -m unittest discover -s tests -p test_service.py -v']),['tests/test_service.py']);
 assert.deepEqual(result,['python3 -m unittest tests.test_service -v','python3 -m unittest discover -s tests -p test_service.py -v']);
});
test('no compile path expansion, unsafe paths, discovery wildcards, or policy widening',()=>{
 const result=legacyOfflineCommands(policy(['python3 *','python3 -m unittest discover -s tests -p test_*.py -v']),['../outside.py','tests/test_service.py;touch x','src/module.py']);
 assert.deepEqual(result,['python3 -m py_compile src/module.py']);
});
