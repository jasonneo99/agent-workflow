import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { selectModelRoute } from "./routing.js";

test("approved local holdout notes select local for fast adaptive stages", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/models" || request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "llama3.1" }] }));
      return;
    }
    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo | null;
  if (!address) {
    throw new Error("Test server did not bind to a TCP address.");
  }

  const previousProvider = process.env.DEFAULT_MODEL_PROVIDER;
  const previousMode = process.env.AGENTFLOW_ROUTING_MODE;
  const previousBaseUrl = process.env.LOCAL_MODEL_BASE_URL;
  const previousModel = process.env.LOCAL_MODEL_NAME;
  try {
    process.env.DEFAULT_MODEL_PROVIDER = "openai";
    delete process.env.AGENTFLOW_ROUTING_MODE;
    process.env.LOCAL_MODEL_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
    process.env.LOCAL_MODEL_NAME = "llama3.1";

    const route = await selectModelRoute({
      workflowId: "build-feature",
      stageId: "orient",
      agentId: "task-triager",
      modelTier: "fast",
      providerOverride: undefined,
      compiledBrief: [
        "## Adaptive Preference Notes",
        "- Local Holdout Promotion",
        "- Status: ready",
        "- Approved: yes",
        "- Provider: local",
        "- Max risk: low"
      ].join("\n")
    });

    assert.equal(route.providerId, "local");
    assert.equal(route.modelTier, "fast");
    assert.match(route.reason, /Reviewed local-holdout routing preference selected local/u);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousProvider === undefined) delete process.env.DEFAULT_MODEL_PROVIDER;
    else process.env.DEFAULT_MODEL_PROVIDER = previousProvider;
    if (previousMode === undefined) delete process.env.AGENTFLOW_ROUTING_MODE;
    else process.env.AGENTFLOW_ROUTING_MODE = previousMode;
    if (previousBaseUrl === undefined) delete process.env.LOCAL_MODEL_BASE_URL;
    else process.env.LOCAL_MODEL_BASE_URL = previousBaseUrl;
    if (previousModel === undefined) delete process.env.LOCAL_MODEL_NAME;
    else process.env.LOCAL_MODEL_NAME = previousModel;
  }
});

test("approved local holdout thresholds must pass before selecting local", async () => {
  const previousProvider = process.env.DEFAULT_MODEL_PROVIDER;
  const previousMode = process.env.AGENTFLOW_ROUTING_MODE;
  const previousBaseUrl = process.env.LOCAL_MODEL_BASE_URL;
  const previousModel = process.env.LOCAL_MODEL_NAME;
  try {
    process.env.DEFAULT_MODEL_PROVIDER = "openai";
    delete process.env.AGENTFLOW_ROUTING_MODE;
    process.env.LOCAL_MODEL_BASE_URL = "http://127.0.0.1:9/v1";
    process.env.LOCAL_MODEL_NAME = "llama3.1";

    const route = await selectModelRoute({
      workflowId: "build-feature",
      stageId: "orient",
      agentId: "task-triager",
      modelTier: "fast",
      providerOverride: undefined,
      compiledBrief: [
        "## Adaptive Preference Notes",
        "- Local Holdout Promotion",
        "- Status: ready",
        "- Approved: yes",
        "- Provider: local",
        "- Max risk: low",
        "- Evidence suites: local-holdout-build-feature",
        "- Min evidence suites: 2",
        "- Min quality delta: 0",
        "- Max latency regression ms: 500",
        "- Promotable suites: 1",
        "- Worst quality delta: 0.04",
        "- Worst latency delta ms: 150"
      ].join("\n")
    });

    assert.equal(route.providerId, "openai");
    assert.match(route.reason, /holdout thresholds were not satisfied/u);
    assert.match(route.reason, /promotable suites 1 < 2/u);
  } finally {
    if (previousProvider === undefined) delete process.env.DEFAULT_MODEL_PROVIDER;
    else process.env.DEFAULT_MODEL_PROVIDER = previousProvider;
    if (previousMode === undefined) delete process.env.AGENTFLOW_ROUTING_MODE;
    else process.env.AGENTFLOW_ROUTING_MODE = previousMode;
    if (previousBaseUrl === undefined) delete process.env.LOCAL_MODEL_BASE_URL;
    else process.env.LOCAL_MODEL_BASE_URL = previousBaseUrl;
    if (previousModel === undefined) delete process.env.LOCAL_MODEL_NAME;
    else process.env.LOCAL_MODEL_NAME = previousModel;
  }
});
