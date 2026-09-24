import type { Attributes } from "@opentelemetry/api";
import {
  endStageSpan,
  flushOtelTracing,
  recordStageEvent,
  setStageSpanAttributes,
  startStageSpan,
  type StageOutcome,
  type StageSpanInput
} from "./otel-tracing.js";

export interface StageRouteTelemetry {
  providerId: string;
  modelId?: string;
}

/** Keep optional executor tracing behind a compact, best-effort lifecycle adapter. */
export function createStageTelemetry(
  task: Omit<StageSpanInput, "stagePattern">,
  stagePattern: { type: string }
) {
  const input: StageSpanInput = { ...task, stagePattern: stagePattern.type };
  const span = startStageSpan(input);
  setStageSpanAttributes(span, {
    "agentflow.stage.pattern.json": JSON.stringify(stagePattern)
  });

  return {
    setRoute(route: StageRouteTelemetry): void {
      setStageSpanAttributes(span, {
        "agentflow.provider.id": route.providerId,
        ...(route.modelId ? { "agentflow.model.id": route.modelId } : {})
      });
    },
    event(name: string, attributes?: Attributes): void {
      recordStageEvent(span, name, attributes);
    },
    end(outcome: StageOutcome, errorMessage?: string): void {
      endStageSpan(span, outcome, errorMessage);
    }
  };
}

export const flushStageTelemetry = flushOtelTracing;
