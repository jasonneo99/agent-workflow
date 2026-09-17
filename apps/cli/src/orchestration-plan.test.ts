import assert from "node:assert/strict";
import test from "node:test";
import { createOrchestrationPlan } from "./orchestration-plan.js";

test("routes roadmap questions to one read-only project specialist", () => {
  const plan = createOrchestrationPlan({ projectDir: "/tmp/example-project", task: "What are the next 10 items on the roadmap for this project?" });
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0]?.kind, "agent");
  assert.equal(plan.steps[0]?.target, "technical-architect");
  assert.doesNotMatch(plan.steps[0]?.task ?? "", /make changes/iu);
});

test("does not downgrade an implementation request containing roadmap", () => {
  const plan = createOrchestrationPlan({ projectDir: "/tmp/project", task: "Implement the next roadmap item" });
  assert.equal(plan.executionProfile, "adaptive");
  assert.deepEqual(plan.steps.map((step) => step.target), ["build-feature"]);
  assert.equal(plan.steps[0]?.adaptive, true);
});

test("pins build to product creation and delivery instead of planning", () => {
  const plan = createOrchestrationPlan({ projectDir: "/tmp/project", task: "Build a finished fan telemetry module" });
  const step = plan.steps.find((item) => item.target === "build-feature");
  assert.equal(step?.title, "Adaptive implementation");
  assert.equal(step?.task, "Build a finished fan telemetry module");
});

test("keeps the exhaustive orchestration path as an explicit full profile", () => {
  const plan = createOrchestrationPlan({ projectDir: "/tmp/project", task: "Build a finished fan telemetry module", executionProfile: "full" });
  const step = plan.steps.find((item) => item.target === "build-feature");
  assert.equal(plan.executionProfile, "full");
  assert.equal(step?.title, "Build and deliver product");
  assert.match(step?.task ?? "", /create, verify, package, and deliver/iu);
});
