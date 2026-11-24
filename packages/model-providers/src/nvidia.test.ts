import assert from "node:assert/strict";
import test from "node:test";
import { NvidiaProvider, NVIDIA_DEFAULT_BASE_URL, NVIDIA_DEFAULT_MODEL, nvidiaProviderInput } from "./nvidia.js";
import { selectModelFromCatalog } from "./catalog.js";
import { providerFromEnv } from "./index.js";

test("Nvidia requires its dedicated API key", () => {
  const previous = process.env.NVIDIA_NIM_API_KEY;
  try {
    delete process.env.NVIDIA_NIM_API_KEY;
    assert.throws(() => new NvidiaProvider(), /NVIDIA_NIM_API_KEY is required/u);
  } finally {
    if (previous === undefined) delete process.env.NVIDIA_NIM_API_KEY;
    else process.env.NVIDIA_NIM_API_KEY = previous;
  }
});

test("Nvidia registers a dedicated NIM adapter", () => {
  const previous = process.env.NVIDIA_NIM_API_KEY;
  try {
    process.env.NVIDIA_NIM_API_KEY = "synthetic-nvidia-key";
    const provider = providerFromEnv("nvidia");
    assert.equal(provider.id, "nvidia");
    assert.equal(typeof provider.check, "function");
    assert.equal(typeof provider.executeStage, "function");
  } finally {
    if (previous === undefined) delete process.env.NVIDIA_NIM_API_KEY;
    else process.env.NVIDIA_NIM_API_KEY = previous;
  }
});

test("Nvidia targets the hosted OpenAI-compatible API and free GLM flash model", () => {
  assert.deepEqual(nvidiaProviderInput(), {
    id: "nvidia",
    baseUrlEnv: "NVIDIA_NIM_BASE_URL",
    modelEnv: "NVIDIA_NIM_MODEL",
    apiKeyEnv: "NVIDIA_NIM_API_KEY",
    defaultBaseURL: "https://integrate.api.nvidia.com/v1",
    defaultModel: "z-ai/glm-5.3-flash"
  });
  assert.equal(NVIDIA_DEFAULT_BASE_URL, "https://integrate.api.nvidia.com/v1");
  assert.equal(NVIDIA_DEFAULT_MODEL, "z-ai/glm-5.3-flash");
});

test("Nvidia default model is selected from the compatible model catalog", () => {
  assert.equal(
    selectModelFromCatalog(["llama-3.2-11b-vision", "z-ai/glm-5.3-flash"], "standard", { provider: "compatible" }),
    "z-ai/glm-5.3-flash"
  );
});
