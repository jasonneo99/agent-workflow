import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {deploymentStatus,deploymentStatusWidget} from './deployment-status.js';

test('deployment reports whitelist revisions and redact configuration fields',()=>{
 const directory=mkdtempSync(path.join(tmpdir(),'deployment-status-')),file=path.join(directory,'status.json');
 try {
  writeFileSync(file,JSON.stringify({phase:'up to date',sourceRevision:'a'.repeat(40),installedRevision:'a'.repeat(40),commitsBehind:0,updatedAt:new Date(100000).toISOString(),secret:'fixture-private-value',source:'/private/fixture'}));
  const report=deploymentStatus(file,100000);assert.equal(report.stale,false);assert.equal(report.commitsBehind,0);
  assert.equal(report.secret,undefined);assert.equal(report.source,undefined);
  assert.equal(deploymentStatus(file,500001).stale,true);
  writeFileSync(file,JSON.stringify({installedRevision:'<script>',commitsBehind:-1,updatedAt:new Date(9999999).toISOString()}));
  const invalid=deploymentStatus(file,100000);assert.equal(invalid.installedRevision,undefined);assert.equal(invalid.commitsBehind,undefined);assert.equal(invalid.stale,true);
  writeFileSync(file,'bad json');assert.equal(deploymentStatus(file).phase,'status unavailable');
  writeFileSync(file,' '.repeat(17000));assert.equal(deploymentStatus(file).stale,true);
 } finally {rmSync(directory,{recursive:true,force:true});}
});

test('missing deployment status is honest and the widget refreshes without HTML injection',()=>{
 assert.equal(deploymentStatus('/nonexistent-fixture').stale,true);
 const widget=deploymentStatusWidget();assert.match(widget,/textContent=/);assert.doesNotMatch(widget,/innerHTML/);
 assert.match(widget,/setInterval\(refresh,15000\)/);assert.match(widget,/aria-live="polite"/);
});
