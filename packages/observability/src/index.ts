import { createHash } from "node:crypto";
import type {
  ActionReceiptStatus,
  ArtifactStatus,
  WorkflowRunStatus,
  WorkflowTaskStatus
} from "../../storage/src/postgres.js";
import { buildCostQualityReport, type CostQualityReport } from "../../run-reporter/src/index.js";

type AttributeValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };

export interface OtelAttribute {
  key: string;
  value: AttributeValue;
}

export interface OtelSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtelAttribute[];
  events?: Array<{
    name: string;
    timeUnixNano: string;
    attributes: OtelAttribute[];
  }>;
  status: {
    code: number;
    message?: string;
  };
}

export interface OtelMetric {
  name: string;
  description: string;
  unit: string;
  gauge?: {
    dataPoints: Array<{
      asInt?: string;
      asDouble?: number;
      timeUnixNano: string;
      attributes: OtelAttribute[];
    }>;
  };
  sum?: {
    aggregationTemporality: number;
    isMonotonic: boolean;
    dataPoints: Array<{
      asInt?: string;
      asDouble?: number;
      timeUnixNano: string;
      attributes: OtelAttribute[];
    }>;
  };
}

export interface ObservabilityReport {
  generatedAt: string;
  runId: string;
  workflowId: string;
  projectName: string;
  status: string;
  summary: {
    runDurationMs: number | null;
    queueDelayMs: number | null;
    taskCount: number;
    receiptCount: number;
    artifactCount: number;
    routedStages: number;
    providerCalls: number;
    fallbackCount: number;
    averageQuality: number | null;
    totalModelLatencyMs: number;
    averageModelLatencyMs: number | null;
    estimatedCompactPromptTokens: number | null;
    payloadsExported: false;
  };
  resourceSpans: Array<{
    resource: { attributes: OtelAttribute[] };
    scopeSpans: Array<{
      scope: { name: string; version: string };
      spans: OtelSpan[];
    }>;
  }>;
  resourceMetrics: Array<{
    resource: { attributes: OtelAttribute[] };
    scopeMetrics: Array<{
      scope: { name: string; version: string };
      metrics: OtelMetric[];
    }>;
  }>;
}

export function buildObservabilityReport(input: {
  run: WorkflowRunStatus;
  tasks: WorkflowTaskStatus[];
  receipts: ActionReceiptStatus[];
  artifacts: ArtifactStatus[];
  version?: string;
}): ObservabilityReport {
  const version = input.version ?? "unknown";
  const generatedAt = new Date().toISOString();
  const quality = buildCostQualityReport(input);
  const traceId = fixedHex(input.run.id, 32);
  const runStartNs = timeNs(input.run.startedAt);
  const runEndNs = timeNs(input.run.finishedAt ?? generatedAt);
  const rootSpanId = fixedHex(`${input.run.id}:run`, 16);
  const taskSpanIds = new Map(input.tasks.map((task) => [task.id, fixedHex(`${input.run.id}:task:${task.id}`, 16)]));
  const firstTaskStart = input.tasks
    .map((task) => task.startedAt ? Date.parse(task.startedAt) : null)
    .filter((value): value is number => value !== null && Number.isFinite(value))
    .sort((a, b) => a - b)[0] ?? null;
  const queueDelayMs = firstTaskStart === null ? null : Math.max(0, firstTaskStart - Date.parse(input.run.startedAt));
  const compactPromptTokens = estimateCompactPromptTokens(input.artifacts);

  const spans: OtelSpan[] = [
    {
      traceId,
      spanId: rootSpanId,
      name: `agentflow.run ${input.run.workflowId}`,
      kind: 1,
      startTimeUnixNano: runStartNs,
      endTimeUnixNano: runEndNs,
      attributes: attrs({
        "agentflow.run.id": input.run.id,
        "agentflow.workflow.id": input.run.workflowId,
        "agentflow.project.name": input.run.projectName,
        "agentflow.project.root": input.run.projectRootUri,
        "agentflow.run.status": input.run.status,
        "agentflow.policy.profile": input.run.policyProfile,
        "agentflow.policy.snapshot_hash": input.run.policySnapshotHash,
        "agentflow.autonomy": input.run.autonomy,
        "agentflow.model.provider_override": input.run.providerOverride,
        "agentflow.model.tier_override": input.run.modelTierOverride,
        "agentflow.task.count": input.tasks.length,
        "agentflow.receipt.count": input.receipts.length,
        "agentflow.artifact.count": input.artifacts.length
      }),
      events: input.receipts.slice(0, 200).map((receipt) => ({
        name: `agentflow.receipt.${receipt.actionType}`,
        timeUnixNano: timeNs(receipt.createdAt),
        attributes: attrs({
          "agentflow.agent.id": receipt.agentId,
          "agentflow.action.type": receipt.actionType,
          "agentflow.action.target": receipt.target,
          "agentflow.action.summary": truncate(receipt.summary, 500)
        })
      })),
      status: spanStatus(input.run.status)
    },
    ...input.tasks.map((task) => buildTaskSpan({
      task,
      traceId,
      parentSpanId: rootSpanId,
      spanId: taskSpanIds.get(task.id) ?? fixedHex(task.id, 16),
      quality
    })),
    ...input.artifacts
      .filter((artifact) => artifact.kind === "model_route")
      .map((artifact) => buildModelRouteSpan({
        artifact,
        traceId,
        parentSpanId: spanIdForArtifactTask(artifact, taskSpanIds, rootSpanId)
      })),
    ...input.artifacts
      .filter((artifact) => artifact.kind === "command_output" || artifact.kind === "file_write" || artifact.kind === "action_rejection")
      .map((artifact) => buildActionSpan({
        artifact,
        traceId,
        parentSpanId: spanIdForArtifactTask(artifact, taskSpanIds, rootSpanId)
      }))
  ];

  const resourceAttributes = attrs({
    "service.name": "agent-workflow",
    "service.version": version,
    "agentflow.project.name": input.run.projectName,
    "agentflow.workflow.id": input.run.workflowId
  });
  const metricTime = timeNs(input.run.finishedAt ?? generatedAt);
  const metricAttrs = attrs({
    "agentflow.run.id": input.run.id,
    "agentflow.workflow.id": input.run.workflowId,
    "agentflow.project.name": input.run.projectName
  });

  return {
    generatedAt,
    runId: input.run.id,
    workflowId: input.run.workflowId,
    projectName: input.run.projectName,
    status: input.run.status,
    summary: {
      runDurationMs: durationMs(input.run.startedAt, input.run.finishedAt),
      queueDelayMs,
      taskCount: input.tasks.length,
      receiptCount: input.receipts.length,
      artifactCount: input.artifacts.length,
      routedStages: quality.routedStages,
      providerCalls: quality.stages.length,
      fallbackCount: quality.fallbackCount,
      averageQuality: quality.averageQuality,
      totalModelLatencyMs: quality.totalLatencyMs,
      averageModelLatencyMs: quality.averageLatencyMs,
      estimatedCompactPromptTokens: compactPromptTokens,
      payloadsExported: false
    },
    resourceSpans: [{
      resource: { attributes: resourceAttributes },
      scopeSpans: [{
        scope: { name: "agent-workflow", version },
        spans
      }]
    }],
    resourceMetrics: [{
      resource: { attributes: resourceAttributes },
      scopeMetrics: [{
        scope: { name: "agent-workflow", version },
        metrics: [
          gauge("agentflow.run.duration", "Workflow run duration.", "ms", durationMs(input.run.startedAt, input.run.finishedAt), metricTime, metricAttrs),
          gauge("agentflow.queue.delay", "Delay from run creation to first task start.", "ms", queueDelayMs, metricTime, metricAttrs),
          gauge("agentflow.model.latency.total", "Total recorded model latency.", "ms", quality.totalLatencyMs, metricTime, metricAttrs),
          gauge("agentflow.model.latency.average", "Average recorded model latency.", "ms", quality.averageLatencyMs, metricTime, metricAttrs),
          gauge("agentflow.quality.average", "Average output quality score.", "1", quality.averageQuality, metricTime, metricAttrs),
          sum("agentflow.task.count", "Workflow task count.", "1", input.tasks.length, metricTime, metricAttrs),
          sum("agentflow.receipt.count", "Action receipt count.", "1", input.receipts.length, metricTime, metricAttrs),
          sum("agentflow.artifact.count", "Artifact count.", "1", input.artifacts.length, metricTime, metricAttrs),
          sum("agentflow.fallback.count", "Provider fallback count.", "1", quality.fallbackCount, metricTime, metricAttrs)
        ]
      }]
    }]
  };
}

export function formatObservabilityReport(report: ObservabilityReport): string {
  return [
    `Observability Report: ${report.runId}`,
    `Status: ${report.status}`,
    `Workflow: ${report.workflowId}`,
    `Project: ${report.projectName}`,
    "",
    "Summary",
    `- Run duration: ${report.summary.runDurationMs ?? "n/a"}ms`,
    `- Queue delay: ${report.summary.queueDelayMs ?? "n/a"}ms`,
    `- Tasks: ${report.summary.taskCount}`,
    `- Receipts: ${report.summary.receiptCount}`,
    `- Artifacts: ${report.summary.artifactCount}`,
    `- Provider calls: ${report.summary.providerCalls}`,
    `- Fallbacks: ${report.summary.fallbackCount}`,
    `- Average quality: ${report.summary.averageQuality ?? "n/a"}`,
    `- Model latency: ${report.summary.totalModelLatencyMs}ms total, ${report.summary.averageModelLatencyMs ?? "n/a"}ms avg`,
    `- Estimated compact prompt tokens: ${report.summary.estimatedCompactPromptTokens ?? "n/a"}`,
    "- Payload export: disabled",
    "",
    "OpenTelemetry",
    `- Resource spans: ${report.resourceSpans.length}`,
    `- Spans: ${report.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans)).length}`,
    `- Metrics: ${report.resourceMetrics.flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics)).length}`
  ].join("\n");
}

function buildTaskSpan(input: {
  task: WorkflowTaskStatus;
  traceId: string;
  parentSpanId: string;
  spanId: string;
  quality: CostQualityReport;
}): OtelSpan {
  const stage = input.quality.stages.find((item) => item.stageId === input.task.stageId && item.agentId === input.task.agentId);
  return {
    traceId: input.traceId,
    spanId: input.spanId,
    parentSpanId: input.parentSpanId,
    name: `agentflow.stage ${input.task.stageId}`,
    kind: 1,
    startTimeUnixNano: timeNs(input.task.startedAt),
    endTimeUnixNano: timeNs(input.task.finishedAt ?? input.task.startedAt),
    attributes: attrs({
      "agentflow.task.id": input.task.id,
      "agentflow.stage.id": input.task.stageId,
      "agentflow.agent.id": input.task.agentId,
      "agentflow.task.status": input.task.status,
      "agentflow.task.attempts": input.task.attempts,
      "agentflow.model.provider": stage?.providerId,
      "agentflow.model.tier": stage?.modelTier,
      "agentflow.quality.score": stage?.qualityScore,
      "agentflow.quality.passed": stage?.qualityPassed,
      "agentflow.fallback.used": stage?.fallbackUsed,
      "agentflow.latency.ms": stage?.latencyMs
    }),
    status: spanStatus(input.task.status)
  };
}

function buildModelRouteSpan(input: {
  artifact: ArtifactStatus;
  traceId: string;
  parentSpanId: string;
}): OtelSpan {
  const route = objectValue(input.artifact.content.route);
  const quality = objectValue(input.artifact.content.quality);
  const latencyMs = numberValue(input.artifact.content.latencyMs);
  const created = timeNs(input.artifact.createdAt);
  return {
    traceId: input.traceId,
    spanId: fixedHex(input.artifact.uri, 16),
    parentSpanId: input.parentSpanId,
    name: "agentflow.model.route",
    kind: 3,
    startTimeUnixNano: subtractMsNs(input.artifact.createdAt, latencyMs ?? 0),
    endTimeUnixNano: created,
    attributes: attrs({
      "agentflow.artifact.uri": input.artifact.uri,
      "agentflow.stage.id": stringValue(input.artifact.content.stageId),
      "agentflow.agent.id": stringValue(input.artifact.content.agentId),
      "agentflow.model.provider": stringValue(route.providerId),
      "agentflow.model.tier": stringValue(route.modelTier),
      "agentflow.model.requested_tier": stringValue(route.requestedModelTier),
      "agentflow.cost.tier": stringValue(route.estimatedCostTier),
      "agentflow.fallback.used": booleanValue(input.artifact.content.fallbackUsed),
      "agentflow.fallback.provider": stringValue(input.artifact.content.fallbackProviderId),
      "agentflow.quality.score": numberValue(quality.score),
      "agentflow.quality.passed": booleanValue(quality.passed),
      "agentflow.latency.ms": latencyMs
    }),
    status: { code: booleanValue(quality.passed) === false ? 2 : 1 }
  };
}

function buildActionSpan(input: {
  artifact: ArtifactStatus;
  traceId: string;
  parentSpanId: string;
}): OtelSpan {
  const duration = numberValue(input.artifact.content.durationMs);
  const created = timeNs(input.artifact.createdAt);
  const exitCode = numberValue(input.artifact.content.exitCode);
  const failed = input.artifact.kind === "action_rejection" || (exitCode !== undefined && exitCode !== 0) || booleanValue(input.artifact.content.timedOut) === true;
  return {
    traceId: input.traceId,
    spanId: fixedHex(input.artifact.uri, 16),
    parentSpanId: input.parentSpanId,
    name: `agentflow.action.${input.artifact.kind}`,
    kind: 1,
    startTimeUnixNano: subtractMsNs(input.artifact.createdAt, duration ?? 0),
    endTimeUnixNano: created,
    attributes: attrs({
      "agentflow.artifact.uri": input.artifact.uri,
      "agentflow.artifact.kind": input.artifact.kind,
      "agentflow.action.target": stringValue(input.artifact.content.relativePath) ?? stringValue(input.artifact.content.commandLine) ?? stringValue(input.artifact.content.target),
      "agentflow.action.exit_code": exitCode,
      "agentflow.action.timed_out": booleanValue(input.artifact.content.timedOut),
      "agentflow.action.bytes_written": numberValue(input.artifact.content.bytesWritten),
      "agentflow.action.error": stringValue(input.artifact.content.error)
    }),
    status: { code: failed ? 2 : 1 }
  };
}

function gauge(name: string, description: string, unit: string, value: number | null, timeUnixNano: string, attributes: OtelAttribute[]): OtelMetric {
  return {
    name,
    description,
    unit,
    gauge: {
      dataPoints: [{
        asDouble: value ?? undefined,
        timeUnixNano,
        attributes
      }]
    }
  };
}

function sum(name: string, description: string, unit: string, value: number, timeUnixNano: string, attributes: OtelAttribute[]): OtelMetric {
  return {
    name,
    description,
    unit,
    sum: {
      aggregationTemporality: 2,
      isMonotonic: true,
      dataPoints: [{
        asInt: String(value),
        timeUnixNano,
        attributes
      }]
    }
  };
}

function attrs(input: Record<string, unknown>): OtelAttribute[] {
  return Object.entries(input).flatMap(([key, value]) => {
    const attr = attrValue(value);
    return attr ? [{ key, value: attr }] : [];
  });
}

function attrValue(value: unknown): AttributeValue | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  return { stringValue: sanitizeAttributeText(String(value)) };
}

function sanitizeAttributeText(value: string): string {
  return truncate(value
    .replace(/(authorization:\s*bearer\s+)[^\s"']+/gi, "$1[redacted-token]")
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/g, "[redacted-openai-key]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted-aws-key]")
    .replace(/\b((?:api[_-]?key|token|secret|password)=)[^\s&]+/gi, "$1[redacted]"), 500);
}

function spanStatus(status: string): { code: number; message?: string } {
  if (status === "failed" || status === "cancelled") {
    return { code: 2, message: status };
  }
  return { code: 1 };
}

function durationMs(start: string | null | undefined, end: string | null | undefined): number | null {
  if (!start || !end) return null;
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) ? Math.max(0, value) : null;
}

function timeNs(value: string | null | undefined): string {
  const ms = value ? Date.parse(value) : Date.now();
  const safeMs = Number.isFinite(ms) ? ms : Date.now();
  return `${BigInt(safeMs) * 1_000_000n}`;
}

function subtractMsNs(value: string, ms: number): string {
  const end = Date.parse(value);
  const safeEnd = Number.isFinite(end) ? end : Date.now();
  return `${BigInt(Math.max(0, safeEnd - Math.max(0, Math.round(ms)))) * 1_000_000n}`;
}

function fixedHex(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function spanIdForArtifactTask(artifact: ArtifactStatus, taskSpanIds: Map<string, string>, fallback: string): string {
  return artifact.taskId ? taskSpanIds.get(artifact.taskId) ?? fallback : fallback;
}

function estimateCompactPromptTokens(artifacts: ArtifactStatus[]): number | null {
  const compiled = artifacts.find((artifact) => artifact.kind === "compiled_brief");
  const text = stringValue(compiled?.content.text);
  return text ? Math.ceil(text.length / 4) : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;
}
