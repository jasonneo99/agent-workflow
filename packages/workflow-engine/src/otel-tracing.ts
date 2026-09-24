/**
 * OpenTelemetry tracing for the workflow executor.
 *
 * Emits one span per executed workflow stage (`agentflow.stage/<stageId>`)
 * to an OTLP/HTTP-compatible backend (OpenObserve, Jaeger, Grafana Tempo,
 * ...). Tracing is strictly best-effort and never breaks stage execution:
 * if the SDK cannot start, or the collector is unreachable, spans are
 * dropped silently.
 *
 * Configuration:
 * - OTEL_EXPORTER_OTLP_ENDPOINT: base OTLP/HTTP endpoint of the backend,
 *   e.g. http://localhost:4318 (default) or http://localhost:5080/api/default
 *   for OpenObserve. The exporter appends `/v1/traces`.
 * - OTEL_EXPORTER_OTLP_HEADERS: extra headers for the exporter, e.g.
 *   `Authorization=Basic <base64(email:password)>` for backends that require
 *   basic auth (OpenObserve does). Handled natively by the OTLP exporter.
 * - OTEL_TRACING_ENABLED=0: disable tracing entirely.
 */

import { trace, SpanStatusCode, type Attributes, type Span, type Tracer } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

export const OTEL_ENDPOINT_ENV_VAR = "OTEL_EXPORTER_OTLP_ENDPOINT";
export const OTEL_TRACING_ENABLED_ENV_VAR = "OTEL_TRACING_ENABLED";
export const DEFAULT_OTLP_ENDPOINT = "http://localhost:4318";
export const INSTRUMENTATION_SCOPE = "agent-workflow.executor";
export const INSTRUMENTATION_VERSION = "0.1.0";

let sdk: NodeSDK | null = null;
let sdkInitFailed = false;

/** Base OTLP/HTTP endpoint, from OTEL_EXPORTER_OTLP_ENDPOINT or the default. */
export function resolveOtlpEndpoint(): string {
  const raw = (process.env[OTEL_ENDPOINT_ENV_VAR] ?? "").trim();
  if (raw.length === 0) return DEFAULT_OTLP_ENDPOINT;
  return raw.replace(/\/+$/u, "");
}

export function isOtelTracingEnabled(): boolean {
  return (process.env[OTEL_TRACING_ENABLED_ENV_VAR] ?? "").trim() !== "0";
}

function ensureSdk(): NodeSDK | null {
  if (!isOtelTracingEnabled()) return null;
  if (sdk) return sdk;
  if (sdkInitFailed) return null;
  try {
    const exporter = new OTLPTraceExporter({ url: `${resolveOtlpEndpoint()}/v1/traces` });
    const next = new NodeSDK({ traceExporter: exporter });
    next.start();
    sdk = next;
  } catch {
    sdkInitFailed = true;
    sdk = null;
  }
  return sdk;
}

function getTracer(): Tracer | null {
  if (!ensureSdk()) return null;
  return trace.getTracer(INSTRUMENTATION_SCOPE, INSTRUMENTATION_VERSION);
}

export interface StageSpanInput {
  workflowId: string;
  runId: string;
  taskId: string;
  stageId: string;
  stagePattern: string;
  agentId: string;
  projectRootUri: string;
}

/** Start the span for one stage execution. Returns undefined when disabled. */
export function startStageSpan(input: StageSpanInput): Span | undefined {
  const tracer = getTracer();
  if (!tracer) return undefined;
  return tracer.startSpan(`agentflow.stage/${input.stageId}`, {
    attributes: {
      "agentflow.workflow.id": input.workflowId,
      "agentflow.run.id": input.runId,
      "agentflow.task.id": input.taskId,
      "agentflow.stage.id": input.stageId,
      "agentflow.stage.pattern": input.stagePattern,
      "agentflow.agent.id": input.agentId,
      "agentflow.project.root": input.projectRootUri
    }
  });
}

/** Attach late-known attributes (provider, model) to a live stage span. */
export function setStageSpanAttributes(span: Span | undefined, attributes: Attributes): void {
  if (!span) return;
  span.setAttributes(attributes);
}

/** Record a point-in-time executor event (verify retry, fallback, ...) on the span. */
export function recordStageEvent(span: Span | undefined, name: string, attributes?: Attributes): void {
  if (!span) return;
  span.addEvent(name, attributes);
}

export type StageOutcome = "completed" | "blocked" | "failed";

/** End a stage span, recording the outcome and any error message. */
export function endStageSpan(span: Span | undefined, outcome: StageOutcome, errorMessage?: string): void {
  if (!span) return;
  span.setAttribute("agentflow.stage.outcome", outcome);
  if (outcome === "failed") {
    span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage?.slice(0, 512) ?? "stage failed" });
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }
  span.end();
}

/**
 * Best-effort flush of queued spans without shutting the SDK down, so
 * long-lived workers keep tracing across batches.
 */
export async function flushOtelTracing(): Promise<void> {
  if (!sdk) return;
  try {
    const provider = trace.getTracerProvider() as unknown as { forceFlush?: () => Promise<void> };
    if (typeof provider.forceFlush === "function") {
      await provider.forceFlush();
    }
  } catch {
    // Tracing is best-effort; a failed flush never breaks the run.
  }
}

/** Shut the SDK down (tests, process exit). The next span starts a fresh SDK. */
export async function shutdownOtelTracing(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch {
    // best-effort
  } finally {
    sdk = null;
  }
}
