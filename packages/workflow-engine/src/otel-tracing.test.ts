import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_OTLP_ENDPOINT,
  endStageSpan,
  isOtelTracingEnabled,
  recordStageEvent,
  resolveOtlpEndpoint,
  setStageSpanAttributes,
  shutdownOtelTracing,
  startStageSpan,
  type StageSpanInput
} from "./otel-tracing.js";

const STAGE: StageSpanInput = {
  workflowId: "wf-demo",
  runId: "run-demo",
  taskId: "task-demo",
  stageId: "collect",
  stagePattern: "collect",
  agentId: "agent-demo",
  projectRootUri: "file:///tmp/demo"
};

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(vars)) {
    saved.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("OTLP endpoint resolves from env, trims slashes, falls back to default", () => {
  withEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: undefined }, () => {
    assert.equal(resolveOtlpEndpoint(), DEFAULT_OTLP_ENDPOINT);
    assert.equal(resolveOtlpEndpoint(), "http://localhost:4318");
  });
  withEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:5080/api/default///" }, () => {
    assert.equal(resolveOtlpEndpoint(), "http://localhost:5080/api/default");
  });
  withEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "   " }, () => {
    assert.equal(resolveOtlpEndpoint(), DEFAULT_OTLP_ENDPOINT);
  });
});

test("OTEL_TRACING_ENABLED=0 disables tracing and yields no span", () => {
  withEnv({ OTEL_TRACING_ENABLED: "0" }, () => {
    assert.equal(isOtelTracingEnabled(), false);
    assert.equal(startStageSpan(STAGE), undefined);
  });
  withEnv({ OTEL_TRACING_ENABLED: undefined }, () => {
    assert.equal(isOtelTracingEnabled(), true);
  });
});

test("stage span lifecycle is safe with no collector listening", async () => {
  // Points at a port nothing listens on: export fails in the background and
  // must never throw into the caller.
  withEnv(
    { OTEL_TRACING_ENABLED: undefined, OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:43189" },
    () => {
      const span = startStageSpan(STAGE);
      assert.ok(span, "expected a live span when tracing is enabled");
      setStageSpanAttributes(span, { "agentflow.provider.id": "mock" });
      recordStageEvent(span, "agentflow.verify.retry", { "agentflow.verify.retry.round": 1 });
      endStageSpan(span, "completed");
      const failed = startStageSpan({ ...STAGE, stageId: "verify" });
      endStageSpan(failed, "failed", "boom");
      // undefined-span helpers are silent no-ops
      endStageSpan(undefined, "blocked", "nope");
      recordStageEvent(undefined, "agentflow.verify.retry");
      setStageSpanAttributes(undefined, { a: "b" });
    }
  );
  await shutdownOtelTracing();
});
