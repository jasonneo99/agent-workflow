import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { autoProviderCandidates, selectModelRoute } from "./routing.js";

test("routine low-risk stages downshift to fast while risky tasks preserve their tier", async () => {
  const previousProvider = process.env.DEFAULT_MODEL_PROVIDER;
  const previousMode = process.env.AGENTFLOW_ROUTING_MODE;
  try {
    process.env.DEFAULT_MODEL_PROVIDER = "mock";
    process.env.AGENTFLOW_ROUTING_MODE = "fixed";
    const routine = await selectModelRoute({ workflowId: "build-feature", stageId: "verify", agentId: "auto-test-runner", modelTier: "standard", workflowTask: "Update a button label", compiledBrief: "" });
    assert.equal(routine.modelTier, "fast");
    assert.match(routine.reason, /Downshifted from standard/u);
    const risky = await selectModelRoute({ workflowId: "build-feature", stageId: "verify", agentId: "auto-test-runner", modelTier: "standard", workflowTask: "Change production authentication", compiledBrief: "" });
    assert.equal(risky.modelTier, "standard");
  } finally {
    if (previousProvider === undefined) delete process.env.DEFAULT_MODEL_PROVIDER; else process.env.DEFAULT_MODEL_PROVIDER = previousProvider;
    if (previousMode === undefined) delete process.env.AGENTFLOW_ROUTING_MODE; else process.env.AGENTFLOW_ROUTING_MODE = previousMode;
  }
});

test("provider smoke prefers proven fast hosted routes while preserving readiness fallback", () => {
  const previousSmokeProviders = process.env.AGENTFLOW_SMOKE_PROVIDERS;
  const previousAutoProviders = process.env.AGENTFLOW_AUTO_PROVIDERS;
  try {
    delete process.env.AGENTFLOW_SMOKE_PROVIDERS;
    process.env.AGENTFLOW_AUTO_PROVIDERS = "local,mock";
    assert.deepEqual(autoProviderCandidates("fast", "provider-smoke").slice(0, 4), ["openai", "anthropic", "gemini", "codex-cli"]);
    process.env.AGENTFLOW_SMOKE_PROVIDERS = "codex-cli,openai";
    assert.deepEqual(autoProviderCandidates("fast", "provider-smoke"), ["codex-cli", "openai", "mock"]);
  } finally {
    if (previousSmokeProviders === undefined) delete process.env.AGENTFLOW_SMOKE_PROVIDERS;
    else process.env.AGENTFLOW_SMOKE_PROVIDERS = previousSmokeProviders;
    if (previousAutoProviders === undefined) delete process.env.AGENTFLOW_AUTO_PROVIDERS;
    else process.env.AGENTFLOW_AUTO_PROVIDERS = previousAutoProviders;
  }
});

test("daemon comparison preferences select the proven provider for the job tier", async () => {
  const previousProvider = process.env.DEFAULT_MODEL_PROVIDER;
  const previousMode = process.env.AGENTFLOW_ROUTING_MODE;
  try {
    process.env.DEFAULT_MODEL_PROVIDER = "openai";
    delete process.env.AGENTFLOW_ROUTING_MODE;
    const route = await selectModelRoute({ workflowId: "review-pr", stageId: "review", agentId: "security-reviewer", modelTier: "reasoning", providerOverride: undefined, compiledBrief: "## Adaptive Preference Notes\n- Preferred provider reasoning: mock\n" });
    assert.equal(route.providerId, "mock");
    assert.match(route.reason, /learning daemon selected mock/u);
  } finally {
    if (previousProvider === undefined) delete process.env.DEFAULT_MODEL_PROVIDER; else process.env.DEFAULT_MODEL_PROVIDER = previousProvider;
    if (previousMode === undefined) delete process.env.AGENTFLOW_ROUTING_MODE; else process.env.AGENTFLOW_ROUTING_MODE = previousMode;
  }
});

test("fresh per-agent task evidence selects the provider and model without overriding explicit routes", async () => {
  const previousProvider = process.env.DEFAULT_MODEL_PROVIDER;
  try {
    process.env.DEFAULT_MODEL_PROVIDER = "openai";
    const evidence = JSON.stringify({ agentId: "test-engineer", taskClass: "verify", providerId: "mock", modelId: "mock-fast", samples: 6, quality: 0.91, taskSuccess: 1, fallbackRate: 0, latencyMs: 800, costUsd: 0, observedAt: new Date().toISOString() });
    const route = await selectModelRoute({ workflowId: "build-feature", stageId: "verify", agentId: "test-engineer", modelTier: "fast", providerOverride: undefined, compiledBrief: `## Adaptive Route Evidence\n- ${evidence}\n` });
    assert.equal(route.providerId, "mock");
    assert.equal(route.modelOverride, "mock-fast");
    assert.match(route.reason, /fresh per-agent task evidence/u);

    const explicit = await selectModelRoute({ workflowId: "build-feature", stageId: "verify", agentId: "test-engineer", modelTier: "fast", providerOverride: "openai", modelOverride: "gpt-explicit", compiledBrief: `## Adaptive Route Evidence\n- ${evidence}\n` });
    assert.equal(explicit.providerId, "openai");
    assert.equal(explicit.modelOverride, "gpt-explicit");
  } finally {
    if (previousProvider === undefined) delete process.env.DEFAULT_MODEL_PROVIDER;
    else process.env.DEFAULT_MODEL_PROVIDER = previousProvider;
  }
});

test("worker capability quarantine routes default work to a healthy allowed provider", async () => {
  const previousProvider = process.env.DEFAULT_MODEL_PROVIDER;
  try {
    process.env.DEFAULT_MODEL_PROVIDER = "codex-cli";
    const route = await selectModelRoute({
      workflowId: "build-feature",
      stageId: "implement",
      agentId: "implementation-agent",
      modelTier: "standard",
      providerOverride: undefined,
      compiledBrief: ""
    }, { allowedProviderIds: ["mock"] });
    assert.equal(route.providerId, "mock");
    assert.match(route.reason, /Worker capability routing replaced an unavailable preferred provider/u);
  } finally {
    if (previousProvider === undefined) delete process.env.DEFAULT_MODEL_PROVIDER;
    else process.env.DEFAULT_MODEL_PROVIDER = previousProvider;
  }
});

test("adaptive routing can select Muse from the configured provider pool", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "muse-spark-1.1" }] }));
      return;
    }
    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error("Test server did not bind to a TCP address.");

  const previous = {
    provider: process.env.DEFAULT_MODEL_PROVIDER,
    mode: process.env.AGENTFLOW_ROUTING_MODE,
    candidates: process.env.AGENTFLOW_AUTO_PROVIDERS,
    key: process.env.MUSE_API_KEY,
    baseUrl: process.env.MUSE_BASE_URL,
    model: process.env.MUSE_MODEL
  };
  try {
    process.env.DEFAULT_MODEL_PROVIDER = "auto";
    process.env.AGENTFLOW_ROUTING_MODE = "adaptive";
    process.env.AGENTFLOW_AUTO_PROVIDERS = "muse";
    process.env.MUSE_API_KEY = "test-muse-key";
    process.env.MUSE_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.MUSE_MODEL = "muse-spark-1.1";

    const route = await selectModelRoute({
      workflowId: "build-feature",
      stageId: "implement",
      agentId: "implementation-agent",
      modelTier: "standard",
      providerOverride: undefined,
      compiledBrief: ""
    });

    assert.equal(route.providerId, "muse");
    assert.match(route.reason, /muse:ready/u);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const [key, value] of Object.entries({
      DEFAULT_MODEL_PROVIDER: previous.provider,
      AGENTFLOW_ROUTING_MODE: previous.mode,
      AGENTFLOW_AUTO_PROVIDERS: previous.candidates,
      MUSE_API_KEY: previous.key,
      MUSE_BASE_URL: previous.baseUrl,
      MUSE_MODEL: previous.model
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

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
