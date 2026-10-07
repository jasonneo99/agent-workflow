import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { handleNotificationAcknowledgment } from "./notification-ack-http.js";

test("network acknowledgment requires receiver credential and rejects caller-selected bindings", async () => {
  let calls=0;
  let unavailable=false;
  const token="a".repeat(64);
  const body={ notificationId:"123e4567-e89b-42d3-a456-426614174000",runId:"123e4567-e89b-42d3-a456-426614174001" };
  const server=createServer((request,response)=>{ void handleNotificationAcknowledgment(request,response,async input=>{
    calls++; assert.equal(input.token,token); assert.equal(input.notificationId,body.notificationId);
    if(unavailable) throw new Error("Storage unavailable");
    return true;
  }); });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  try {
    const address=server.address(); assert.ok(address&&typeof address!=="string");
    const url=`http://127.0.0.1:${address.port}/api/notification-ack`;
    const send=(payload:unknown,authorization?:string)=>fetch(url,{method:"POST",headers:authorization?{authorization}: {},body:JSON.stringify(payload)});
    assert.equal((await send(body)).status,403);
    assert.equal((await send({...body,authenticatedBinding:{taskId:"victim"}},`Bearer ${token}`)).status,400);
    assert.equal((await send({runId:"invalid",notificationId:body.notificationId},`Bearer ${token}`)).status,400);
    assert.equal((await send("x".repeat(4097),`Bearer ${token}`)).status,413);
    assert.equal(calls,0);
    const result=await send(body,`Bearer ${token}`);
    assert.equal(result.status,200); assert.deepEqual(await result.json(),{acknowledged:true}); assert.equal(calls,1);
    unavailable=true;
    const failed=await send(body,`Bearer ${token}`);
    assert.equal(failed.status,503); assert.deepEqual(await failed.json(),{acknowledged:false});
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }
});
