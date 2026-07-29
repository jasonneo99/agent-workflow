import { BedrockClient, ListFoundationModelsCommand } from "@aws-sdk/client-bedrock";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import type { FileSummaryInput, FileSummaryOutput, ModelProvider, StageExecutionInput, StageExecutionOutput } from "./types.js";
import {
  buildFileSummaryPrompt,
  buildStagePrompt,
  extractJsonObject,
  normalizeFileSummaryArtifact,
  normalizeStageArtifact,
  type FileSummaryJsonArtifact,
  type StageJsonArtifact
} from "./prompts.js";

const defaultBedrockModel = "us.anthropic.claude-sonnet-4-20250514-v1:0";

export class BedrockProvider implements ModelProvider {
  id = "bedrock";
  protected readonly model: string;
  protected readonly region: string;
  protected readonly runtimeClient: BedrockRuntimeClient;
  private readonly controlClient: BedrockClient;

  constructor(input: { model?: string; region?: string; id?: string } = {}) {
    this.id = input.id ?? this.id;
    this.model = input.model ?? process.env.BEDROCK_MODEL ?? defaultBedrockModel;
    this.region = input.region ?? process.env.BEDROCK_REGION ?? process.env.AWS_REGION ?? "us-east-1";
    this.runtimeClient = new BedrockRuntimeClient({ region: this.region });
    this.controlClient = new BedrockClient({ region: this.region });
  }

  async check(): Promise<{ ready: boolean; details: string[] }> {
    try {
      await this.controlClient.send(new ListFoundationModelsCommand({}));
      return {
        ready: true,
        details: [`${this.id} configured. Model: ${this.model}. Region: ${this.region}.`]
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ready: false,
        details: [
          `${this.id} provider check failed: ${message}`,
          ...providerRecoveryHints(this.id, message)
        ]
      };
    }
  }

  async executeStage(input: StageExecutionInput): Promise<StageExecutionOutput> {
    const text = await this.converseJson({
      system: [
        "You are executing one stage in a durable agent workflow.",
        "Return one valid JSON object only.",
        "Do not claim that files, commands, or external systems changed unless the stage input explicitly includes that evidence."
      ].join(" "),
      prompt: buildStagePrompt(input),
      temperature: 0.2
    });
    const parsed = normalizeStageArtifact(extractJsonObject(text) as StageJsonArtifact);

    return {
      summary: parsed.summary,
      requestedCommands: parsed.requestedCommands,
      requestedFileWrites: parsed.requestedFileWrites,
      artifact: {
        provider: this.id,
        model: this.model,
        runId: input.runId,
        taskId: input.taskId,
        workflowId: input.workflowId,
        workflowTask: input.workflowTask,
        stageId: input.stageId,
        agentId: input.agentId,
        agentName: input.agentName,
        stageGoal: input.stageGoal,
        findings: parsed.findings,
        nextAction: parsed.nextAction,
        requestedCommands: parsed.requestedCommands,
        requestedFileWrites: parsed.requestedFileWrites,
        summary: parsed.summary
      }
    };
  }

  async summarizeFile(input: FileSummaryInput): Promise<FileSummaryOutput> {
    const text = await this.converseJson({
      system: [
        "Summarize one project file for future coding-agent context retrieval.",
        "Return one valid JSON object only.",
        "Emphasize purpose, public interfaces, commands, constraints, and when an agent should read this file."
      ].join(" "),
      prompt: buildFileSummaryPrompt(input),
      temperature: 0.1
    });
    const parsed = normalizeFileSummaryArtifact(extractJsonObject(text) as FileSummaryJsonArtifact);
    const summary = [
      parsed.summary,
      parsed.keyFacts.length ? `Key facts: ${parsed.keyFacts.join(" | ")}` : "",
      parsed.likelyUseWhen.length ? `Use when: ${parsed.likelyUseWhen.join(" | ")}` : ""
    ].filter(Boolean).join("\n");

    return {
      summary,
      artifact: {
        provider: this.id,
        model: this.model,
        sourceUri: input.sourceUri,
        refined: true,
        keyFacts: parsed.keyFacts,
        likelyUseWhen: parsed.likelyUseWhen
      }
    };
  }

  private async converseJson(input: { system: string; prompt: string; temperature: number }): Promise<string> {
    const response = await this.runtimeClient.send(new ConverseCommand({
      modelId: this.model,
      system: [{ text: input.system }],
      messages: [
        {
          role: "user",
          content: [{ text: input.prompt }]
        }
      ],
      inferenceConfig: {
        temperature: input.temperature
      }
    }));

    const text = response.output?.message?.content
      ?.map((block) => "text" in block ? block.text ?? "" : "")
      .join("")
      .trim();
    if (!text) {
      throw new Error(`${this.id} returned an empty response.`);
    }
    return text;
  }
}

export function defaultKiroModel(): string {
  return process.env.KIRO_MODEL ?? process.env.BEDROCK_MODEL ?? defaultBedrockModel;
}

export function defaultKiroRegion(): string {
  return process.env.KIRO_REGION ?? process.env.AWS_REGION ?? process.env.BEDROCK_REGION ?? "us-east-1";
}

function providerRecoveryHints(providerId: string, message: string): string[] {
  if (!isCredentialError(message)) {
    return [];
  }

  const profile = process.env.AWS_PROFILE;
  const loginCommand = profile ? `aws sso login --profile ${profile}` : "aws sso login --profile <profile>";
  const prefix = providerId === "kiro" ? "Kiro" : "Bedrock";
  return [
    `${prefix} could not load AWS credentials. If your SSO session expired, run: ${loginCommand}`,
    "Or switch Agent Workflow back to OpenAI with: npm run agentflow -- provider-use openai --check",
    profile
      ? `Then retry with: AWS_PROFILE=${profile} DEFAULT_MODEL_PROVIDER=${providerId} npm run provider-check`
      : `If you use a named SSO profile, retry with: AWS_PROFILE=<profile> DEFAULT_MODEL_PROVIDER=${providerId} npm run provider-check`
  ];
}

function isCredentialError(message: string): boolean {
  const normalized = message.toLowerCase();
  return [
    "could not load credentials",
    "unable to locate credentials",
    "sso token",
    "token has expired",
    "token for",
    "credentials"
  ].some((pattern) => normalized.includes(pattern));
}
