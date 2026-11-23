import assert from 'node:assert/strict';import test from 'node:test';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {registerProviderCreditTool} from './reporting.js';
test('MCP credit measurements expose bounded read-only requests and refuse malformed provider selection before dispatch',async()=>{
 const server=new McpServer({name:'synthetic-credit-server',version:'1'}),client=new Client({name:'synthetic-credit-client',version:'1'}),calls:string[][]=[];
 registerProviderCreditTool(server,async(args,timeout)=>{calls.push(args);assert.equal(timeout,60000);return {content:[{type:'text',text:'{"status":"unknown"}'}]};});
 const [ct,st]=InMemoryTransport.createLinkedPair();try{await server.connect(st);await client.connect(ct);
 const tool=(await client.listTools()).tools.find(tool=>tool.name==='agentflow_provider_credits')!;assert.equal(tool.annotations?.readOnlyHint,true);
 for(const providers of [[],['openrouter,--persist'],Array(21).fill('openrouter'),['../credentials']]){const result=await client.callTool({name:tool.name,arguments:{providers}});assert.equal(result.isError,true);}
 assert.equal(calls.length,0);const result=await client.callTool({name:tool.name,arguments:{providers:['openrouter','codex-cli']}});assert.notEqual(result.isError,true);assert.deepEqual(calls,[['provider-credits','--providers','openrouter,codex-cli']]);
 }finally{await client.close();await server.close();}
});
