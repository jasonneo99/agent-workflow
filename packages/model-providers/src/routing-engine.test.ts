import assert from "node:assert/strict";
import test from "node:test";
import { compileAirHeader, parseAirHeader } from "../../context-compiler/src/air.js";
import {
  buildRoutingEngineInput,
  compileRoutingHeader,
  RuleBasedRoutingEngine,
  type RoutingEngineInput
} from "./routing-engine.js";

const engine = new RuleBasedRoutingEngine();

function engineInput(overrides: Partial<RoutingEngineInput> = {}): RoutingEngineInput {
  return {
    goal: "ship it",
    state: [],
    known: [],
    need: "",
    plan: [],
    active: "s1",
    results: [],
    budget: {},
    policy: {},
    modelTier: "standard",
    workflowId: "wf",
    stageId: "s1",
    agentId: "a1",
    ...overrides
  };
}

test("engine parses per-tier preferred providers from structured known lines", () => {
  const decision = engine.decide(engineInput({
    known: ["Preferred provider fast: local", "Preferred provider reasoning: anthropic"]
  }));
  assert.equal(decision.preferredProviderByTier.fast, "local");
  assert.equal(decision.preferredProviderByTier.reasoning, "anthropic");
  assert.equal(decision.preferredProviderByTier.standard, undefined);
});

test("engine rejects malformed provider ids", () => {
  const decision = engine.decide(engineInput({ known: ["Preferred provider fast: ../../evil"] }));
  assert.equal(decision.preferredProviderByTier.fast, undefined);
});

test("engine promotes on revision/rejection feedback signals", () => {
  const decision = engine.decide(engineInput({
    known: ["Prior stage was revised by reviewer", "unrelated note"],
    state: [{ key: "review", fact: "rejected: missing tests" }]
  }));
  assert.equal(decision.promoteFastStages, true);
  assert.equal(decision.feedbackSignals.length, 2);
});

test("engine approves local holdout only when all gates pass", () => {
  const base = [
    "Local Holdout Promotion",
    "Status: ready",
    "Approved: yes",
    "Provider: local",
    "Max risk: low",
    "Evidence suites: 12",
    "Min evidence suites: 10",
    "Min quality delta: 0.02",
    "Worst quality delta: 0.05",
    "Max latency regression ms: 200",
    "Worst latency delta ms: 120"
  ];
  const ok = engine.decide(engineInput({ known: base }));
  assert.equal(ok.localHoldout.approved, true);
  assert.equal(ok.localHoldout.provider, "local");
  assert.equal(ok.localHoldout.maxRisk, "low");
  assert.equal(ok.localHoldout.evidenceSuites, 12);

  const notReady = engine.decide(engineInput({
    known: base.map((line) => (line.startsWith("Status:") ? "Status: pending" : line))
  }));
  assert.equal(notReady.localHoldout.approved, false);
});

test("engine emits a low-budget tier hint", () => {
  const decision = engine.decide(engineInput({ budget: { tokens: "low" } }));
  assert.equal(decision.tierHint, "fast");
});

test("engine reports low confidence when the header carries no signal", () => {
  const decision = engine.decide(engineInput());
  assert.ok(decision.confidence < 0.5, `expected low confidence, got ${decision.confidence}`);
});

test("engine reports high confidence when signals are present", () => {
  const decision = engine.decide(engineInput({ known: ["Preferred provider fast: local"] }));
  assert.ok(decision.confidence >= 0.5, `expected usable confidence, got ${decision.confidence}`);
});

test("header round-trips through compile -> parse -> decide", () => {
  const header = compileAirHeader({
    goal: "fix auth",
    state: [{ key: "branch", fact: "feature/auth" }],
    known: ["Preferred provider fast: local"],
    need: "locate token code",
    plan: ["inspect", "patch"],
    active: "inspect",
    budget: { tokens: "low", timeSeconds: 90 },
    policy: { write: "yes", network: "no" }
  });
  const parsed = parseAirHeader(header);
  const decision = engine.decide({ ...parsed, modelTier: "fast", workflowId: "wf", stageId: "s1", agentId: "a1" });
  assert.equal(decision.preferredProviderByTier.fast, "local");
  assert.equal(decision.tierHint, "fast");
  assert.deepEqual(parsed.state, [{ key: "branch", fact: "feature/auth" }]);
  assert.deepEqual(parsed.plan, ["inspect", "patch"]);
  assert.equal(parsed.budget.timeSeconds, 90);
});

test("buildRoutingEngineInput extracts preference notes and policy from stage input", () => {
  const input = buildRoutingEngineInput({
    modelTier: "fast",
    agentId: "a1",
    stageId: "s1",
    workflowId: "wf",
    workflowTask: "overall task",
    stageGoal: "stage goal",
    compiledBrief: "# Brief\n\n## Adaptive Preference Notes\n- Preferred provider fast: local\n- Status: ready\n\n## Next\nbody",
    projectConfig: { actions: { allowed_write_paths: ["src/**"], allowed_commands: ["npm test"] } } as never
  });
  assert.equal(input.goal, "stage goal");
  assert.deepEqual(input.known, ["Preferred provider fast: local", "Status: ready"]);
  assert.equal(input.policy.write, "yes");
  assert.equal(input.policy.commands, "yes");
  assert.equal(input.budget.tokens, "low");
});

test("compileRoutingHeader produces the canonical nine-field block", () => {
  const header = compileRoutingHeader({
    modelTier: "standard",
    agentId: "a1",
    stageId: "s1",
    workflowId: "wf",
    workflowTask: "task",
    stageGoal: "goal",
    compiledBrief: ""
  });
  assert.equal(header.split("\n").length, 9);
  assert.match(header, /^GOAL      goal$/m);
});
