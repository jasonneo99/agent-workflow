import assert from 'node:assert/strict';import test from 'node:test';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {parseCodexNativeQuota,readCodexRateLimits} from './codex-credit-probe.js';
test('native quota parsing keeps native credits separate and drops private and malformed fields',()=>{
 const data=parseCodexNativeQuota({rateLimits:{primary:{usedPercent:25,windowDurationMins:300,resetsAt:1900000000,private:'synthetic-secret'},credits:{hasCredits:true,unlimited:true,balance:null},email:'private@example.com'}})!;
 assert.equal(data.credits?.balance,null);assert.equal(data.credits?.unit,'codex-native-credits');assert.equal(JSON.stringify(data).includes('private'),false);
 assert.equal(parseCodexNativeQuota({rateLimits:{primary:{usedPercent:NaN},credits:{hasCredits:'yes'}}}),undefined);
});
test('stdio probe sends only the read-only protocol, filters unrelated credentials and cleans up its child',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-credit-probe-'));try{
 const script=path.join(root,'probe.mjs');await fs.writeFile(script,`import readline from 'node:readline';if(process.env.OPENAI_API_KEY||process.env.DATABASE_URL)process.exit(9);const input=readline.createInterface({input:process.stdin});input.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{}}));else if(m.method==='initialized'){}else if(m.method==='account/rateLimits/read')console.log(JSON.stringify({id:m.id,result:{rateLimits:{primary:{usedPercent:51,windowDurationMins:10080,resetsAt:1900000000}}}}));else process.exit(8);});`);
 const result=await readCodexRateLimits({command:process.execPath,argsPrefix:[script],env:{PATH:process.env.PATH,HOME:root,OPENAI_API_KEY:'synthetic-secret',DATABASE_URL:'synthetic-private'},timeoutMs:2000});
 assert.equal(parseCodexNativeQuota(result)?.primary?.usedPercent,51);
 const hanging=path.join(root,'hang.mjs');await fs.writeFile(hanging,'setInterval(()=>{},1000);');const start=Date.now();assert.equal(await readCodexRateLimits({command:process.execPath,argsPrefix:[hanging],timeoutMs:50}),undefined);assert.ok(Date.now()-start<2000);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
