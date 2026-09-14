import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { authenticateFleetClient, createFleetModelGateway, estimateModelCost, importFleetUsageReceipts, readFleetUsageReceipts, summarizeFleetUsage, usageFromPayload, type FleetUsageReceipt } from "./index.js";

test("fleet client authentication requires an exact bearer token", () => {
  assert.equal(authenticateFleetClient("Bearer secret-a", { "client-a": "secret-a" }), "client-a");
  assert.equal(authenticateFleetClient("Bearer wrong", { "client-a": "secret-a" }), null);
  assert.equal(authenticateFleetClient(undefined, { "client-a": "secret-a" }), null);
});

test("normalizes Responses and chat-completions usage without bodies", () => {
  assert.deepEqual(usageFromPayload({ usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 } } }), { inputTokens: 12, cachedInputTokens: 3, reasoningTokens: 2, outputTokens: 5, totalTokens: 17 });
  assert.equal(usageFromPayload({ usage: { prompt_tokens: 4, completion_tokens: 6 } }).totalTokens, 10);
});

test("fleet summary aggregates tokens and failures", () => {
  const base: FleetUsageReceipt = { version: 1, id: "one", observedAt: new Date(0).toISOString(), clientId: "host-a", provider: "example", inputTokens: 4, cachedInputTokens: 1, reasoningTokens: 2, outputTokens: 6, totalTokens: 10, latencyMs: 5, status: "completed", requestHash: "hash" };
  const report = summarizeFleetUsage([base, { ...base, id: "two", clientId: "host-b", status: "failed" }]);
  assert.deepEqual(report.clients, ["host-a", "host-b"]);
  assert.equal(report.totals.totalTokens, 20);
  assert.equal(report.totals.failures, 1);
});

test("offline receipt import is idempotent", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-fleet-usage-"));
  const ledger = path.join(directory, "usage.jsonl");
  const receipt: FleetUsageReceipt = { version: 1, id: "offline-one", observedAt: new Date(0).toISOString(), clientId: "host-a", provider: "local", inputTokens: 4, cachedInputTokens: 0, reasoningTokens: 0, outputTokens: 2, totalTokens: 6, latencyMs: 3, status: "completed", requestHash: "hash" };
  assert.equal(await importFleetUsageReceipts(ledger, [receipt]), 1);
  assert.equal(await importFleetUsageReceipts(ledger, [receipt]), 0);
  assert.equal((await readFleetUsageReceipts(ledger)).length, 1);
});

test("estimates configured model cost", () => {
  assert.equal(estimateModelCost({ inputTokens: 1000, cachedInputTokens: 200, reasoningTokens: 0, outputTokens: 500, totalTokens: 1500 }, "model-a", { "model-a": { inputPerMillionUsd: 2, outputPerMillionUsd: 6 } }), 0.0046);
});

test("gateway health and client policies fail closed before upstream", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-gateway-policy-"));
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === "object");
  const gateway = createFleetModelGateway({ upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}`, clientTokens: { client: "token" }, clientPolicies: { client: { allowedModels: ["model-a"], requestsPerMinute: 3, dailyTokenBudget: 100 } }, ledgerPath: path.join(directory, "ledger.jsonl"), provider: "test" });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const gatewayAddress = gateway.address();
  assert.ok(gatewayAddress && typeof gatewayAddress === "object");
  const base = `http://127.0.0.1:${gatewayAddress.port}`;
  try {
    assert.equal((await fetch(`${base}/healthz`, { headers: { authorization: "Bearer token" } })).status, 200);
    assert.equal((await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { authorization: "Bearer token", "content-type": "application/json" }, body: JSON.stringify({ model: "blocked" }) })).status, 403);
    assert.equal((await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { authorization: "Bearer token", "content-type": "application/json" }, body: JSON.stringify({ model: "model-a" }) })).status, 200);
    assert.equal((await readFleetUsageReceipts(path.join(directory, "ledger.jsonl")))[0]?.totalTokens, 3);
  } finally {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("rejects absolute-form request targets without contacting another origin", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-gateway-target-"));
  let attackerRequests = 0;
  const upstream = http.createServer((_request, response) => response.end("{}"));
  const attacker = http.createServer((_request, response) => { attackerRequests += 1; response.end("{}"); });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => attacker.listen(0, "127.0.0.1", resolve));
  const upstreamAddress = upstream.address();
  const attackerAddress = attacker.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === "object");
  assert.ok(attackerAddress && typeof attackerAddress === "object");
  const gateway = createFleetModelGateway({ upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}`, upstreamApiKey: "upstream-secret", clientTokens: { client: "token" }, ledgerPath: path.join(directory, "ledger.jsonl"), provider: "test" });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const gatewayAddress = gateway.address();
  assert.ok(gatewayAddress && typeof gatewayAddress === "object");
  try {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = http.request({ host: "127.0.0.1", port: gatewayAddress.port, path: `http://127.0.0.1:${attackerAddress.port}/capture`, method: "POST", headers: { authorization: "Bearer token", "content-type": "application/json" } }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      });
      request.on("error", reject);
      request.end(JSON.stringify({ model: "model-a" }));
    });
    assert.equal(status, 400);
    assert.equal(attackerRequests, 0);
  } finally {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await new Promise<void>((resolve) => attacker.close(() => resolve()));
  }
});

test("bounds upstream response bodies", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-gateway-response-"));
  const upstream = http.createServer((_request, response) => response.end("response-too-large"));
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === "object");
  const gateway = createFleetModelGateway({ upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}`, clientTokens: { client: "token" }, ledgerPath: path.join(directory, "ledger.jsonl"), maxResponseBytes: 4, provider: "test" });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const gatewayAddress = gateway.address();
  assert.ok(gatewayAddress && typeof gatewayAddress === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${gatewayAddress.port}/v1/responses`, { method: "POST", headers: { authorization: "Bearer token", "content-type": "application/json" }, body: JSON.stringify({ model: "model-a" }) });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: { message: "Gateway request failed." } });
  } finally {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
