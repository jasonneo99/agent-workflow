import test from 'node:test';
import assert from 'node:assert/strict';
import {cardActivity,type CardReceipt} from './queue-card-activity.js';
const now=Date.parse('2026-01-01T00:00:10Z'),item={runId:'one',runStatus:'running',projectRootUri:'/synthetic/one',familyAttempts:[{id:'child',status:'running'}]};
const receipt=(patch:Partial<CardReceipt>={}):CardReceipt=>({runId:'one',rootUri:item.projectRootUri,runStatus:'running',leaseExpiresAt:'2026-01-01T00:01:00Z',action:'execution_progress',target:'src/panel.ts',createdAt:'2026-01-01T00:00:09Z',metadata:{operation:'file_write'},...patch});
test('one replacing narrative follows actual start, changed file, checks and recorded commit',()=>{
 assert.equal(cardActivity(item,[receipt()],now).text,'Now: applying changes to src/panel.ts');
 assert.match(cardActivity(item,[receipt({target:'implementation',metadata:{operation:'agent'}})],now).text,/Now: agent processing implementation/);
 assert.equal(cardActivity(item,[receipt({action:'file_write',metadata:{previousHash:'old',nextHash:'new'}})],now).text,'Changed src/panel.ts');
 assert.equal(cardActivity(item,[receipt({action:'file_write',metadata:{previousHash:'same',nextHash:'same'}})],now).text,'Write recorded: src/panel.ts');
 assert.equal(cardActivity(item,[receipt({action:'local_command',target:'npm run test',metadata:{exitCode:0,timedOut:false}})],now).text,'Passed: npm run test');
 assert.match(cardActivity(item,[receipt({action:'commit_created',metadata:{commitHash:'a'.repeat(40)}})],now).text,/Recorded commit a{12}/);
 assert.match(cardActivity(item,[receipt({action:'local_command',target:'git commit -m private',metadata:{exitCode:0}})],now).text,/Commit command completed/);
});
test('expired or old starts never claim activity; terminal execution is not acceptance',()=>{
 assert.equal(cardActivity(item,[receipt({leaseExpiresAt:null})],now).current,false);
 assert.match(cardActivity(item,[receipt({leaseExpiresAt:null})],now).text,/Last started.*awaiting a result/);
 assert.equal(cardActivity(item,[receipt()],now+180000).current,false);
 assert.match(cardActivity({...item,runStatus:'completed'},[],now).text,/acceptance still requires verification/);
});
test('family scopes stay exact, active attempts outrank history, unsafe arguments stay protected',()=>{
 assert.match(cardActivity(item,[receipt({rootUri:'/foreign'})],now).text,/Waiting/);
 assert.equal(cardActivity(item,[receipt({runId:'unrelated'})],now).observedAt,null);
 assert.match(cardActivity(item,[receipt({runId:'child'}),receipt({runStatus:'failed',createdAt:'2026-01-01T00:00:10Z',action:'stage_failed'})],now).text,/Now:/);
 assert.match(cardActivity(item,[receipt({target:'.env'})],now).text,/protected path/);
 assert.doesNotMatch(cardActivity(item,[receipt({metadata:{operation:'command'},target:'curl https://private/?token=hidden'})],now).text,/private|hidden/);
 assert.equal(cardActivity(item,[receipt({action:'local_command',target:'npm test',metadata:{exitCode:1}})],now).text,'Failed: npm test');
});
