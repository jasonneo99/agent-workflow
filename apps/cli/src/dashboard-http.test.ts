import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { finishDashboardError, workflowDisplayName } from "./dashboard-http.js";

test("missing workflow identities render without inventing a workflow", () => {
  for (const value of [null, undefined, "", " "]) assert.equal(workflowDisplayName(value), "Unspecified workflow");
  assert.equal(workflowDisplayName("build-feature"), "Build Feature");
  assert.equal(workflowDisplayName("debug-failure"), "Diagnose & Fix");
  assert.equal(workflowDisplayName("investigate-issue"), "Investigate Issue");
});

test("request errors before and after headers do not kill the server", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/partial") {
      res.writeHead(200); res.flushHeaders();
      finishDashboardError(res, "failed");
    } else if (req.url === "/failed") {
      finishDashboardError(res, "failed");
    } else {
      res.end("healthy");
      finishDashboardError(res, "must not append");
    }
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const failed = await fetch(`${base}/failed`);
    assert.equal(failed.status, 500);
    assert.equal(await failed.text(), "failed");
    await assert.rejects(async () => { const partial = await fetch(`${base}/partial`); await partial.text(); });
    assert.equal(await (await fetch(base)).text(), "healthy");
  } finally { server.closeAllConnections(); server.close(); }
});
