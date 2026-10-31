import assert from 'node:assert/strict';
import test from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod/v3';
import { bindCodexToolOrigins, codexRequestEnvironment, withCodexRequestOrigin } from './codex-origin.js';
const a='123e4567-e89b-42d3-a456-426614174000',b='123e4567-e89b-42d3-a456-426614174001';

test('request origin replaces inherited chat only in child environment and never mutates global state',()=>{
 const base={CODEX_THREAD_ID:b,AGENTFLOW_REQUESTER_CHANNEL:'studio',AGENTFLOW_ORIGIN_TASK_ID:'other-chat',DATABASE_URL:'synthetic'};
 withCodexRequestOrigin({threadId:a},()=>{assert.deepEqual(codexRequestEnvironment(base),{CODEX_THREAD_ID:a,AGENTFLOW_REQUESTER_CHANNEL:'codex',DATABASE_URL:'synthetic'});});
 assert.equal(base.CODEX_THREAD_ID,b);
 assert.equal(codexRequestEnvironment(base).CODEX_THREAD_ID,b);
});
test('missing host identity cannot inherit startup Codex origin, and malformed metadata fails closed',()=>{
 withCodexRequestOrigin(undefined,()=>{const env=codexRequestEnvironment({CODEX_THREAD_ID:b,AGENTFLOW_REQUESTER_CHANNEL:'codex'});assert.equal(env.CODEX_THREAD_ID,undefined);assert.equal(env.AGENTFLOW_REQUESTER_CHANNEL,undefined);});
 for(const value of ['',null,{},a+'\n','00000000-0000-0000-0000-000000000000'])assert.throws(()=>withCodexRequestOrigin({threadId:value},()=>assert.fail('must not execute')),/Invalid host/);
});
test('MCP transport metadata binds concurrent tools; model arguments cannot select the callback chat',async()=>{
 const server=new McpServer({name:'synthetic-origin-test',version:'1'});bindCodexToolOrigins(server);
 server.registerTool('schema_tool',{inputSchema:{threadId:z.string().optional(),delay:z.number()}},async({delay})=>{await new Promise(resolve=>setTimeout(resolve,delay));return {content:[{type:'text',text:JSON.stringify(codexRequestEnvironment({CODEX_THREAD_ID:b}))}]};});
 server.registerTool('no_args',{},async()=>({content:[{type:'text',text:JSON.stringify(codexRequestEnvironment({CODEX_THREAD_ID:b}))}]}));
 const client=new Client({name:'synthetic-host',version:'1'});const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
 try {
 const [one,two]=await Promise.all([client.callTool({name:'schema_tool',arguments:{threadId:b,delay:20},_meta:{threadId:a}}),client.callTool({name:'schema_tool',arguments:{threadId:a,delay:0},_meta:{threadId:b}})]);
 const env=(r:unknown)=>JSON.parse((r as {content:{text:string}[]}).content[0].text);
 assert.equal(env(one).CODEX_THREAD_ID,a);assert.equal(env(two).CODEX_THREAD_ID,b);
 assert.equal(env(await client.callTool({name:'no_args',_meta:{threadId:a}})).CODEX_THREAD_ID,a);
 assert.equal(env(await client.callTool({name:'schema_tool',arguments:{threadId:a,delay:0}})).CODEX_THREAD_ID,undefined);
 assert.equal((await client.callTool({name:'no_args',_meta:{threadId:'invalid'}})).isError,true);
 }finally{await client.close();await server.close();}
});
