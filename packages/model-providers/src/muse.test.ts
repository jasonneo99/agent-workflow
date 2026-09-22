import assert from "node:assert/strict";
import test from "node:test";
import { providerFromEnv } from "./index.js";
import { MUSE_DEFAULT_BASE_URL, MUSE_DEFAULT_MODEL, MuseProvider, museProviderInput } from "./muse.js";

test("Muse provider requires MUSE_API_KEY", () => {
  const previous = process.env.MUSE_API_KEY;
  try {
    delete process.env.MUSE_API_KEY;
    assert.throws(() => new MuseProvider(), /MUSE_API_KEY is required when DEFAULT_MODEL_PROVIDER=muse/);
  } finally {
    restoreEnv("MUSE_API_KEY", previous);
  }
});

test("Muse provider registers as the muse adapter", () => {
  const previous = process.env.MUSE_API_KEY;
  try {
    process.env.MUSE_API_KEY = "test-key";
    const provider = providerFromEnv("muse");
    assert.ok(provider instanceof MuseProvider);
    assert.equal(provider.id, "muse");
  } finally {
    restoreEnv("MUSE_API_KEY", previous);
  }
});

test("Muse provider input targets the Meta Model API with muse-spark-1.1", () => {
  assert.deepEqual(museProviderInput(), {
    id: "muse",
    baseUrlEnv: "MUSE_BASE_URL",
    modelEnv: "MUSE_MODEL",
    apiKeyEnv: "MUSE_API_KEY",
    defaultBaseURL: MUSE_DEFAULT_BASE_URL,
    defaultModel: MUSE_DEFAULT_MODEL
  });
  assert.equal(MUSE_DEFAULT_BASE_URL, "https://api.meta.ai/v1");
  assert.equal(MUSE_DEFAULT_MODEL, "muse-spark-1.1");
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
