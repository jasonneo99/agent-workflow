import type {ProjectConfig} from '../../agent-registry/src/schemas.js';
import {testEvidence} from '../../run-environments/src/evidence.js';

/** Taken from the selected trusted profile, never an observed result's counts. */
export type DeclaredVerificationRule=Parameters<typeof testEvidence>[1];

export interface VerificationRecipeEvidence {
 status:'passed'|'failed';cases:number|null;passed:number|null;skipped:number|null;reason:string|null;
}
/** A process exit is not proof that tests executed. Recompute this from the
 * actual retained output, including when validating an older artifact that
 * predates this metadata. Unknown/truncated formats remain unverified. */
export function verificationRecipeEvidence(input:{commandLine:string;stdout:string;stderr:string;exitCode:number|null;timedOut:boolean;outputTruncated?:boolean},recipes:ProjectConfig['actions']['verification_recipes'],declaration?:DeclaredVerificationRule):VerificationRecipeEvidence|undefined {
 if(!recipes?.some(r=>r.commands.includes(input.commandLine)))return undefined;
 const text=(input.stdout+'\n'+input.stderr).replaceAll('\r\n','\n').replace(/\u001b\[[0-9;]*m/gu,'');
 const failed=(reason:string,cases:number|null=null,passed:number|null=null,skipped:number|null=null):VerificationRecipeEvidence=>({status:'failed',cases,passed,skipped,reason});
 if(input.exitCode!==0||input.timedOut)return failed('The declared test command failed or timed out.');
 if(input.outputTruncated||text.includes('\n...[middle truncated]...\n'))return failed('Complete test collection evidence was truncated.');
 if(declaration){
  if(!declaration.commands.includes(input.commandLine))return failed('The selected environment rule does not match this literal command.');
  return testEvidence(input,declaration);
 }
 if(/^python3 -m unittest /u.test(input.commandLine)){
  const counts=[...text.matchAll(/^Ran (\d+) tests? in [^\r\n]+$/gm)];
  const outcomes=[...text.matchAll(/^OK(?: \(([^\r\n]*)\))?\s*$/gm)];
  if(counts.length!==1||outcomes.length!==1)return failed('Expected one complete unittest collection summary.');
  const cases=Number(counts[0]![1]),details=outcomes[0]![1]??'',skipped=Number(/(?:^|[, ])skipped=(\d+)/u.exec(details)?.[1]??0);
  const passed=cases-skipped;
  if(cases<1||passed<1||skipped>0||/expected failures|unexpected successes|FAILED|^ERROR:/mu.test(text))return failed('The recipe requires at least one executed passing test and zero skipped or unverified cases.',cases,passed,skipped);
  return {status:'passed',cases,passed,skipped,reason:null};
 }
 if(/^node (?:--import tsx )?--test /u.test(input.commandLine)){
  const count=(name:string)=>{const matches=[...text.matchAll(new RegExp('^(?:#|ℹ) '+name+' (\\d+)\\s*$','gmu'))];return matches.length===1?Number(matches[0]![1]):null;};
  const cases=count('tests'),passed=count('pass'),skipped=count('skipped'),failures=count('fail'),cancelled=count('cancelled'),todo=count('todo');
  if(cases===null||passed===null||skipped===null||failures===null||cancelled===null||todo===null)return failed('Expected one complete Node test summary.',cases,passed,skipped);
  if(cases<1||passed!==cases||skipped>0||failures>0||cancelled>0||todo>0)return failed('The recipe requires passing executed tests with no failed, cancelled, skipped or todo cases.',cases,passed,skipped);
  return {status:'passed',cases,passed,skipped,reason:null};
 }
 return failed('This declared recipe has no supported test evidence parser.');
}
