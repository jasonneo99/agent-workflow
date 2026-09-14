import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

export interface FleetUsageReceipt {
  version: 1;
  id: string;
  observedAt: string;
  clientId: string;
  projectId?: string;
  workflowId?: string;
  runId?: string;
  stageId?: string;
  provider: string;
  model?: string;
  inputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
  latencyMs: number;
  status: "completed" | "failed";
  requestHash: string;
}

export interface FleetGatewayConfig {
  upstreamBaseUrl: string;
  upstreamApiKey?: string;
  clientTokens: Record<string, string>;
  ledgerPath: string;
  provider: string;
  maxBodyBytes?: number;
  maxResponseBytes?: number;
  upstreamTimeoutMs?: number;
  clientPolicies?: Record<string, FleetClientPolicy>;
  modelPricing?: Record<string, { inputPerMillionUsd: number; outputPerMillionUsd: number }>;
}

export interface FleetClientPolicy {
  allowedModels?: string[];
  requestsPerMinute?: number;
  dailyTokenBudget?: number;
}

const metadataHeaders = {
  projectId: "x-agentflow-project",
  workflowId: "x-agentflow-workflow",
  runId: "x-agentflow-run",
  stageId: "x-agentflow-stage"
} as const;

function boundedString(value: string | string[] | undefined, max = 128): string | undefined {
  const text = Array.isArray(value) ? value[0] : value;
  return text?.trim().slice(0, max) || undefined;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function authenticateFleetClient(authorization: string | undefined, clientTokens: Record<string, string>): string | null {
  const supplied = authorization?.match(/^Bearer\s+(.+)$/iu)?.[1];
  if (!supplied) return null;
  for (const [clientId, token] of Object.entries(clientTokens)) {
    if (token && safeEqual(supplied, token)) return clientId;
  }
  return null;
}

export function usageFromPayload(payload: unknown): Pick<FleetUsageReceipt, "inputTokens" | "cachedInputTokens" | "reasoningTokens" | "outputTokens" | "totalTokens"> {
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const usage = root.usage && typeof root.usage === "object" ? root.usage as Record<string, unknown> : {};
  const inputDetails = usage.input_tokens_details && typeof usage.input_tokens_details === "object"
    ? usage.input_tokens_details as Record<string, unknown>
    : usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
      ? usage.prompt_tokens_details as Record<string, unknown>
      : {};
  const outputDetails = usage.output_tokens_details && typeof usage.output_tokens_details === "object"
    ? usage.output_tokens_details as Record<string, unknown>
    : usage.completion_tokens_details && typeof usage.completion_tokens_details === "object"
      ? usage.completion_tokens_details as Record<string, unknown>
      : {};
  const number = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  const inputTokens = number(usage.input_tokens ?? usage.prompt_tokens);
  const outputTokens = number(usage.output_tokens ?? usage.completion_tokens);
  return {
    inputTokens,
    cachedInputTokens: number(inputDetails.cached_tokens),
    reasoningTokens: number(outputDetails.reasoning_tokens),
    outputTokens,
    totalTokens: number(usage.total_tokens) || inputTokens + outputTokens
  };
}

export async function appendFleetUsageReceipt(ledgerPath: string, receipt: FleetUsageReceipt): Promise<void> {
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true, mode: 0o700 });
  await fs.appendFile(ledgerPath, `${JSON.stringify(receipt)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function readFleetUsageReceipts(ledgerPath: string): Promise<FleetUsageReceipt[]> {
  try {
    return (await fs.readFile(ledgerPath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as FleetUsageReceipt);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function importFleetUsageReceipts(ledgerPath: string, incoming: FleetUsageReceipt[]): Promise<number> {
  const existingIds = new Set((await readFleetUsageReceipts(ledgerPath)).map((item) => item.id));
  let imported = 0;
  for (const receipt of incoming) {
    if (receipt.version !== 1 || !receipt.id || !receipt.clientId || existingIds.has(receipt.id)) continue;
    await appendFleetUsageReceipt(ledgerPath, receipt);
    existingIds.add(receipt.id);
    imported += 1;
  }
  return imported;
}

export function summarizeFleetUsage(receipts: FleetUsageReceipt[]) {
  const totals = receipts.reduce((sum, item) => ({
    requests: sum.requests + 1,
    inputTokens: sum.inputTokens + item.inputTokens,
    cachedInputTokens: sum.cachedInputTokens + item.cachedInputTokens,
    reasoningTokens: sum.reasoningTokens + item.reasoningTokens,
    outputTokens: sum.outputTokens + item.outputTokens,
    totalTokens: sum.totalTokens + item.totalTokens,
    failures: sum.failures + (item.status === "failed" ? 1 : 0),
    estimatedCostUsd: sum.estimatedCostUsd + (item.estimatedCostUsd ?? 0)
  }), { requests: 0, inputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, outputTokens: 0, totalTokens: 0, failures: 0, estimatedCostUsd: 0 });
  return { version: 1, generatedAt: new Date().toISOString(), totals, clients: [...new Set(receipts.map((item) => item.clientId))].sort(), receipts };
}

export function estimateModelCost(usage: ReturnType<typeof usageFromPayload>, model: string | undefined, pricing: FleetGatewayConfig["modelPricing"]): number | undefined {
  const price = model ? pricing?.[model] : undefined;
  if (!price) return undefined;
  return Number((((usage.inputTokens - usage.cachedInputTokens) * price.inputPerMillionUsd + usage.outputTokens * price.outputPerMillionUsd) / 1_000_000).toFixed(8));
}

async function readBody(request: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error("Request body exceeds the configured gateway limit.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readUpstreamBody(response: Response, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new Error("Upstream response exceeds the configured gateway limit.");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("Upstream response exceeds the configured gateway limit.");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function resolveUpstreamTarget(requestUrl: string | undefined, upstream: URL): URL | null {
  if (!requestUrl?.startsWith("/")) return null;
  const parsed = new URL(requestUrl, "http://gateway.invalid");
  const target = new URL(`${parsed.pathname}${parsed.search}`, upstream);
  return target.origin === upstream.origin ? target : null;
}

export function createFleetModelGateway(config: FleetGatewayConfig): http.Server {
  const upstream = new URL(config.upstreamBaseUrl);
  if (!["http:", "https:"].includes(upstream.protocol) || upstream.username || upstream.password) {
    throw new Error("The fleet gateway upstream must be an HTTP(S) URL without embedded credentials.");
  }
  const maxBodyBytes = config.maxBodyBytes ?? 10_000_000;
  const maxResponseBytes = config.maxResponseBytes ?? 25_000_000;
  const requestWindows = new Map<string, number[]>();
  return http.createServer(async (request, response) => {
    const clientId = authenticateFleetClient(request.headers.authorization, config.clientTokens);
    if (!clientId) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Valid fleet gateway credentials are required." } }));
      return;
    }
    if (request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ status: "ready", provider: config.provider, ledger: "configured" }));
      return;
    }
    const policy = config.clientPolicies?.[clientId] ?? {};
    const now = Date.now();
    const recent = (requestWindows.get(clientId) ?? []).filter((timestamp) => timestamp > now - 60_000);
    if (policy.requestsPerMinute && recent.length >= policy.requestsPerMinute) {
      response.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
      response.end(JSON.stringify({ error: { message: "Fleet gateway request rate exceeded." } }));
      return;
    }
    recent.push(now);
    requestWindows.set(clientId, recent);
    const startedAt = Date.now();
    const requestId = randomUUID();
    try {
      const body = await readBody(request, maxBodyBytes);
      const requestPayload = body.length ? JSON.parse(body.toString("utf8")) as Record<string, unknown> : {};
      const requestedModel = boundedString(typeof requestPayload.model === "string" ? requestPayload.model : undefined);
      if (policy.allowedModels?.length && (!requestedModel || !policy.allowedModels.includes(requestedModel))) {
        response.writeHead(403, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "The requested model is not allowed for this fleet client." } }));
        return;
      }
      if (policy.dailyTokenBudget) {
        const dayStart = new Date();
        dayStart.setUTCHours(0, 0, 0, 0);
        const usedToday = (await readFleetUsageReceipts(config.ledgerPath))
          .filter((item) => item.clientId === clientId && new Date(item.observedAt) >= dayStart)
          .reduce((sum, item) => sum + item.totalTokens, 0);
        if (usedToday >= policy.dailyTokenBudget) {
          response.writeHead(429, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "The fleet client's daily token budget is exhausted." } }));
          return;
        }
      }
      const forwardedPayload = requestPayload.stream === true
        ? { ...requestPayload, stream_options: { ...(requestPayload.stream_options as Record<string, unknown> | undefined), include_usage: true } }
        : requestPayload;
      const forwardedBody = body.length ? JSON.stringify(forwardedPayload) : undefined;
      const target = resolveUpstreamTarget(request.url, upstream);
      if (!target) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "A relative gateway request target is required." } }));
        return;
      }
      const upstreamResponse = await fetch(target, {
        method: request.method,
        headers: {
          "content-type": request.headers["content-type"] ?? "application/json",
          ...(config.upstreamApiKey ? { authorization: `Bearer ${config.upstreamApiKey}` } : {})
        },
        body: request.method === "GET" || request.method === "HEAD" ? undefined : forwardedBody,
        signal: AbortSignal.timeout(config.upstreamTimeoutMs ?? 120_000)
      });
      const responseBody = await readUpstreamBody(upstreamResponse, maxResponseBytes);
      let responsePayload: unknown = {};
      const responseText = responseBody.toString("utf8");
      try { responsePayload = JSON.parse(responseText); } catch {
        for (const line of responseText.split("\n")) {
          if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
          try {
            const event = JSON.parse(line.slice(6)) as Record<string, unknown>;
            if (event.usage) responsePayload = event;
          } catch {}
        }
      }
      const usage = usageFromPayload(responsePayload);
      const estimatedCostUsd = estimateModelCost(usage, requestedModel, config.modelPricing);
      await appendFleetUsageReceipt(config.ledgerPath, {
        version: 1,
        id: requestId,
        observedAt: new Date().toISOString(),
        clientId,
        projectId: boundedString(request.headers[metadataHeaders.projectId]),
        workflowId: boundedString(request.headers[metadataHeaders.workflowId]),
        runId: boundedString(request.headers[metadataHeaders.runId]),
        stageId: boundedString(request.headers[metadataHeaders.stageId]),
        provider: config.provider,
        model: requestedModel,
        ...usage,
        ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
        latencyMs: Date.now() - startedAt,
        status: upstreamResponse.ok ? "completed" : "failed",
        requestHash: createHash("sha256").update(requestId).update(body).digest("hex")
      });
      response.writeHead(upstreamResponse.status, { "content-type": upstreamResponse.headers.get("content-type") ?? "application/json", "x-agentflow-request-id": requestId });
      response.end(responseBody);
    } catch {
      response.writeHead(502, { "content-type": "application/json", "x-agentflow-request-id": requestId });
      response.end(JSON.stringify({ error: { message: "Gateway request failed." } }));
    }
  });
}
