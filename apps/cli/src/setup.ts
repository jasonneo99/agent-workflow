/**
 * Interactive CLI onboarding — walks users through provider selection,
 * project initialization, and service setup.
 *
 * Usage: npm run setup
 */
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { agentWorkflowEnvPath, findAgentWorkflowRoot } from "../../../packages/runtime-root/src/index.js";

const rootDir = findAgentWorkflowRoot(import.meta.url);

interface SetupAnswers {
  provider: string;
  openaiKey?: string;
  openaiModel?: string;
  bedrockModel?: string;
  bedrockRegion?: string;
  awsProfile?: string;
  kiroApiKey?: string;
  kiroAgent?: string;
  compatibleBaseUrl?: string;
  compatibleModel?: string;
  compatibleKey?: string;
  byoBaseUrl?: string;
  byoModel?: string;
  byoKey?: string;
  useEnterprise: boolean;
  projectDir?: string;
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question: string): Promise<string> => new Promise((resolve) => rl.question(question, resolve));

  console.log("");
  console.log("  Welcome to Agent Workflow");
  console.log("  ─────────────────────────");
  console.log("  Portable, model-agnostic agent workflows for any codebase.");
  console.log("");

  // Provider selection
  console.log("  Choose your model provider:");
  console.log("");
  console.log("  1) auto          — Smart routing across configured providers by stage tier.");
  console.log("  2) mock          — No model calls. Good for testing workflows locally.");
  console.log("  3) openai        — OpenAI API (GPT-4o, GPT-5.5, etc.)");
  console.log("  4) bedrock       — AWS Bedrock (Nova, Claude, Llama, Mistral)");
  console.log("  5) byo           — Bring your own OpenAI-compatible model gateway");
  console.log("  6) openai-compatible — Same as BYO, with legacy env names");
  console.log("  7) kiro          — Optional Kiro CLI adapter");
  console.log("");

  const providerChoice = await ask("  Provider [1-7, default 1]: ");
  const providerMap: Record<string, string> = { "1": "auto", "2": "mock", "3": "openai", "4": "bedrock", "5": "byo", "6": "openai-compatible", "7": "kiro", "": "auto" };
  const provider = providerMap[providerChoice.trim()] ?? "mock";

  const answers: SetupAnswers = { provider, useEnterprise: false };

  if (provider === "openai") {
    console.log("");
    answers.openaiKey = await ask("  OpenAI API key: ");
    const model = await ask("  Model [default gpt-4o]: ");
    answers.openaiModel = model.trim() || "gpt-4o";
  }

  if (provider === "bedrock") {
    console.log("");
    console.log("  Bedrock uses your AWS credential chain (SSO, env vars, or ~/.aws/credentials).");
    const model = await ask("  Model [default amazon.nova-pro-v1:0]: ");
    answers.bedrockModel = model.trim() || "amazon.nova-pro-v1:0";
    const region = await ask("  AWS region [default us-east-1]: ");
    answers.bedrockRegion = region.trim() || "us-east-1";
    const profile = await ask("  AWS profile (leave blank for default): ");
    answers.awsProfile = profile.trim() || undefined;
  }

  if (provider === "kiro") {
    console.log("");
    console.log("  Kiro uses Kiro CLI. Interactive use can rely on `kiro-cli login`; headless use can set KIRO_API_KEY.");
    const key = await ask("  Kiro API key (leave blank to use existing login): ");
    answers.kiroApiKey = key.trim() || undefined;
    const agent = await ask("  Kiro agent name (leave blank for default): ");
    answers.kiroAgent = agent.trim() || undefined;
  }

  if (provider === "byo") {
    console.log("");
    console.log("  BYO uses any OpenAI-compatible chat-completions endpoint.");
    const baseUrl = await ask("  Base URL [default http://localhost:11434/v1]: ");
    answers.byoBaseUrl = baseUrl.trim() || "http://localhost:11434/v1";
    answers.byoModel = await ask("  Model name (required): ");
    const key = await ask("  API key (leave blank if not needed): ");
    answers.byoKey = key.trim() || undefined;
  }

  if (provider === "openai-compatible") {
    console.log("");
    const baseUrl = await ask("  Base URL [default http://localhost:11434/v1]: ");
    answers.compatibleBaseUrl = baseUrl.trim() || "http://localhost:11434/v1";
    answers.compatibleModel = await ask("  Model name (required): ");
    const key = await ask("  API key (leave blank if not needed): ");
    answers.compatibleKey = key.trim() || undefined;
  }

  // Enterprise vs simple
  console.log("");
  console.log("  Storage mode:");
  console.log("  - Enterprise: PostgreSQL + Redis + Object Storage (run history, dashboard, worker)");
  console.log("  - Simple: File-based output only (no services needed)");
  console.log("");
  const storageChoice = await ask("  Use enterprise storage? [y/N]: ");
  answers.useEnterprise = storageChoice.trim().toLowerCase().startsWith("y");

  // Project init
  console.log("");
  const initProject = await ask("  Initialize a project now? [Y/n]: ");
  if (!initProject.trim().toLowerCase().startsWith("n")) {
    const projectDir = await ask("  Project directory [default .]: ");
    answers.projectDir = projectDir.trim() || ".";
  }

  rl.close();

  // Write .env
  console.log("");
  console.log("  Writing .env...");
  await writeEnvFile(answers);

  // Start services if enterprise
  if (answers.useEnterprise) {
    console.log("  Starting enterprise services (docker compose)...");
    console.log("  Run: docker compose -f infra/docker-compose.yml up -d");
    console.log("  Then: npm run migrate-storage && npm run bootstrap-storage");
  }

  // Init project
  if (answers.projectDir) {
    console.log(`  Initializing project in ${answers.projectDir}...`);
    console.log(`  Run: npm run init-project -- --project ${answers.projectDir} --profile ${answers.useEnterprise ? "enterprise" : "simple"}`);
  }

  // Provider check
  console.log("");
  console.log("  Setup complete! Verify with:");
  console.log("  npm run provider-check");
  console.log("");

  if (answers.useEnterprise && answers.projectDir) {
    console.log("  Then run your first workflow:");
    console.log(`  npm run agentflow -- orchestrate --project ${answers.projectDir} --task "Review project readiness" --dry-run`);
  } else if (answers.projectDir) {
    console.log("  Then compile a brief:");
    console.log(`  npm run compile -- --workflow build-feature --project ${answers.projectDir} --task "Describe your task"`);
  }

  console.log("");
}

async function writeEnvFile(answers: SetupAnswers): Promise<void> {
  const lines: string[] = [];

  if (answers.useEnterprise) {
    lines.push(
      "DATABASE_URL=postgres://agentflow:agentflow@localhost:15432/agentflow",
      "REDIS_URL=redis://localhost:16379",
      "OBJECT_STORAGE_ENDPOINT=http://localhost:19000",
      "OBJECT_STORAGE_BUCKET=agentflow-artifacts",
      "OBJECT_STORAGE_ACCESS_KEY=agentflow",
      "OBJECT_STORAGE_SECRET_KEY=agentflow-secret"
    );
  }

  lines.push(`DEFAULT_MODEL_PROVIDER=${answers.provider}`);

  if (answers.provider === "auto") {
    lines.push("AGENTFLOW_ROUTING_MODE=adaptive");
    lines.push("AGENTFLOW_AUTO_PROVIDERS=byo,bedrock,openai,openai-compatible,kiro");
  }

  if (answers.provider === "openai") {
    lines.push(`OPENAI_API_KEY=${answers.openaiKey ?? ""}`);
    lines.push(`OPENAI_MODEL=${answers.openaiModel ?? "gpt-4o"}`);
  }

  if (answers.provider === "bedrock") {
    lines.push(`BEDROCK_MODEL=${answers.bedrockModel ?? "amazon.nova-pro-v1:0"}`);
    lines.push(`BEDROCK_MODEL_FAST=amazon.nova-lite-v1:0`);
    lines.push(`BEDROCK_MODEL_STANDARD=${answers.bedrockModel ?? "amazon.nova-pro-v1:0"}`);
    lines.push(`BEDROCK_MODEL_REASONING=${answers.bedrockModel ?? "amazon.nova-pro-v1:0"}`);
    lines.push(`AWS_REGION=${answers.bedrockRegion ?? "us-east-1"}`);
    if (answers.awsProfile) {
      lines.push(`AWS_PROFILE=${answers.awsProfile}`);
    }
  }

  if (answers.provider === "kiro") {
    lines.push("KIRO_CLI_BIN=kiro-cli");
    lines.push(`KIRO_API_KEY=${answers.kiroApiKey ?? ""}`);
    lines.push(`KIRO_AGENT=${answers.kiroAgent ?? ""}`);
    lines.push("KIRO_TIMEOUT_MS=600000");
  }

  if (answers.provider === "byo") {
    lines.push(`BYO_MODEL_BASE_URL=${answers.byoBaseUrl ?? "http://localhost:11434/v1"}`);
    lines.push(`BYO_MODEL_NAME=${answers.byoModel ?? ""}`);
    if (answers.byoKey) {
      lines.push(`BYO_MODEL_API_KEY=${answers.byoKey}`);
    } else {
      lines.push("BYO_MODEL_API_KEY=");
    }
  }

  if (answers.provider === "openai-compatible") {
    lines.push(`OPENAI_COMPATIBLE_BASE_URL=${answers.compatibleBaseUrl ?? "http://localhost:11434/v1"}`);
    lines.push(`OPENAI_COMPATIBLE_MODEL=${answers.compatibleModel ?? ""}`);
    if (answers.compatibleKey) {
      lines.push(`OPENAI_COMPATIBLE_API_KEY=${answers.compatibleKey}`);
    }
  }

  lines.push("DEFAULT_AUTONOMY=2");
  lines.push("");

  const envPath = agentWorkflowEnvPath(rootDir);
  await fs.mkdir(path.dirname(envPath), { recursive: true });
  await fs.writeFile(envPath, lines.join("\n"), "utf8");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
