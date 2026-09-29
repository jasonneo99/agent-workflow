import assert from "node:assert/strict";
import test from "node:test";
import { classifyModelAttemptFailure } from "./fallback.js";

test("funding and model-access 4xx errors advance to the next model", () => {
  assert.deepEqual(classifyModelAttemptFailure({ status: 402, message: "Insufficient credits" }, "openai", "model-a").category, "funding");
  assert.equal(classifyModelAttemptFailure({ status: 402, message: "Insufficient credits" }, "openai", "model-a").retryNextModel, true);
  assert.equal(classifyModelAttemptFailure({ status: 403, message: "Project does not have access to model" }, "openai", "model-a").retryNextModel, true);
  assert.equal(classifyModelAttemptFailure({ status: 404, message: "Model not found" }, "openai", "model-a").retryNextModel, true);
  assert.equal(classifyModelAttemptFailure({ status: 429, message: "Rate limit" }, "openai", "model-a").retryNextModel, true);
});

test("authentication and ordinary bad requests fail without probing every model", () => {
  assert.equal(classifyModelAttemptFailure({ status: 401, message: "Invalid API key" }, "openai", "model-a").retryNextModel, false);
  assert.equal(classifyModelAttemptFailure({ status: 400, message: "Malformed input" }, "openai", "model-a").retryNextModel, false);
});
