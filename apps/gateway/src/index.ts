import path from "node:path";
import fs from "node:fs/promises";
import { createFleetModelGateway, importFleetUsageReceipts, readFleetUsageReceipts, summarizeFleetUsage, type FleetUsageReceipt } from "../../../packages/fleet-model-gateway/src/index.js";

const command = process.argv[2] ?? "serve";
const ledgerPath = process.env.AGENTFLOW_FLEET_USAGE_LEDGER ?? path.resolve(".agent-workflow/runtime/fleet-model-usage.jsonl");

if (command === "report") {
  console.log(JSON.stringify(summarizeFleetUsage(await readFleetUsageReceipts(ledgerPath)), null, 2));
} else if (command === "import") {
  const importPath = process.argv[3];
  if (!importPath) throw new Error("Usage: agentflow-model-gateway import <receipt-json-or-jsonl>");
  const raw = await fs.readFile(importPath, "utf8");
  const incoming = raw.trim().startsWith("[")
    ? JSON.parse(raw) as FleetUsageReceipt[]
    : raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as FleetUsageReceipt);
  console.log(`Imported ${await importFleetUsageReceipts(ledgerPath, incoming)} new fleet usage receipt(s).`);
} else {
  const upstreamBaseUrl = process.env.AGENTFLOW_MODEL_GATEWAY_UPSTREAM_URL;
  const clientTokensRaw = process.env.AGENTFLOW_MODEL_GATEWAY_CLIENT_TOKENS;
  if (!upstreamBaseUrl || !clientTokensRaw) throw new Error("AGENTFLOW_MODEL_GATEWAY_UPSTREAM_URL and AGENTFLOW_MODEL_GATEWAY_CLIENT_TOKENS are required.");
  const clientTokens = JSON.parse(clientTokensRaw) as Record<string, string>;
  const clientPolicies = process.env.AGENTFLOW_MODEL_GATEWAY_CLIENT_POLICIES
    ? JSON.parse(process.env.AGENTFLOW_MODEL_GATEWAY_CLIENT_POLICIES)
    : undefined;
  const modelPricing = process.env.AGENTFLOW_MODEL_GATEWAY_PRICING
    ? JSON.parse(process.env.AGENTFLOW_MODEL_GATEWAY_PRICING)
    : undefined;
  const port = Number.parseInt(process.env.AGENTFLOW_MODEL_GATEWAY_PORT ?? "18080", 10);
  const maxResponseBytes = Number.parseInt(process.env.AGENTFLOW_MODEL_GATEWAY_MAX_RESPONSE_BYTES ?? "25000000", 10);
  createFleetModelGateway({ upstreamBaseUrl, upstreamApiKey: process.env.AGENTFLOW_MODEL_GATEWAY_UPSTREAM_API_KEY, clientTokens, clientPolicies, modelPricing, ledgerPath, maxResponseBytes, provider: process.env.AGENTFLOW_MODEL_GATEWAY_PROVIDER ?? "upstream" })
    .listen(port, process.env.AGENTFLOW_MODEL_GATEWAY_HOST ?? "127.0.0.1", () => console.log(`Fleet model gateway listening on port ${port}.`));
}
