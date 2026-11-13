import type {projectConfigSchema} from '../../../../packages/agent-registry/src/schemas.js';
import type {z} from 'zod';
import {assertCommandAllowed} from '../../../../packages/local-tools/src/command-executor.js';
import {materializeVerificationRecipes} from '../../../../packages/storage/src/partner-recovery-admission.js';

/** A broad project test grant is not evidence that its entire suite is offline.
 * Automatic legacy recovery keeps only literal, scope-bound focused tests that
 * the project explicitly names, plus non-executing Python syntax checks/diff.
 * Native/integration gates remain required, but need separately reviewed recipes.
 */
export function legacyOfflineCommands(project:z.infer<typeof projectConfigSchema>,paths:readonly string[]):string[]{
 const inScope=new Set(paths);
 const focused=project.actions.allowed_commands.filter(command=>{
  const module=/^python3 -m unittest (tests\.[A-Za-z0-9_]+)(?: -v)?$/u.exec(command);
  if(module)return inScope.has(`${module[1]!.replaceAll('.','/')}.py`);
  const discovery=/^python3 -m unittest discover -s tests -p (test_[A-Za-z0-9_]+\.py)(?: -v)?$/u.exec(command);
  return Boolean(discovery&&inScope.has(`tests/${discovery[1]}`));
 });
 const python=paths.filter(p=>/^[A-Za-z0-9_./-]+\.py$/u.test(p)&&!p.split('/').some(v=>!v||v==='.'||v==='..'));
 const candidates=[...focused,...materializeVerificationRecipes(project,paths),...python.map(p=>`python3 -m py_compile ${p}`),'git diff --check'];
 return [...new Set(candidates)].filter(command=>{try{assertCommandAllowed(command,project);return true;}catch{return false;}});
}

/** Compilation is not regression execution; never synthesize a test grant. */
export function missingLegacyTestRecipes(project:z.infer<typeof projectConfigSchema>,paths:readonly string[]):string[]{
 const commands=new Set(legacyOfflineCommands(project,paths));
 return paths.filter(path=>/^tests\/test_[A-Za-z0-9_]+\.py$/u.test(path)).filter(path=>{
  const module=path.slice(0,-3).replaceAll('/','.');
  const filename=path.slice('tests/'.length);
  return ![`python3 -m unittest ${module}`,`python3 -m unittest ${module} -v`,
   `python3 -m unittest discover -s tests -p ${filename}`,`python3 -m unittest discover -s tests -p ${filename} -v`].some(c=>commands.has(c));
 });
}
