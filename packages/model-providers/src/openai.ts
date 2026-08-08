import OpenAI from "openai";
import type { FileSummaryInput, FileSummaryOutput, ModelProvider, StageExecutionInput, StageExecutionOutput } from "./types.js";
import {
  buildFileSummaryPrompt,
  buildStagePrompt,
  normalizeFileSummaryArtifact,
  normalizeStageArtifact,
  type FileSummaryJsonArtifact,
  type StageJsonArtifact
} from "./prompts.js";

export class OpenAIProvider implements ModelProvider {
  id = "openai";
  private readonly client: OpenAI;
  private readonly model: string;

  constructor() {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is required when DEFAULT_MODEL_PROVIDER=openai");
    }

    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
    this.model = process.env.OPENAI_MODEL ?? "gpt-5.5";
  }

  async executeStage(input: StageExecutionInput): Promise<StageExecutionOutput> {
    const model = this.resolveModelForTier(input.modelTier);
    const response = await this.client.responses.create({
      model,
      input: [
        {
          role: "system",
          content: [
            "You are executing one stage in a durable agent workflow.",
            "Return concise JSON only.",
            "Do not claim that files, commands, or external systems changed unless the stage input explicitly includes that evidence."
          ].join(" ")
        },
        {
          role: "user",
          content: buildStagePrompt(input)
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "stage_execution_result",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              summary: { type: "string" },
              findings: {
                type: "array",
                items: { type: "string" }
              },
              nextAction: { type: "string" }
              ,
              requestedCommands: {
                type: "array",
                items: { type: "string" }
              },
              requestedFileWrites: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    path: { type: "string" },
                    content: { type: "string" }
                  },
                  required: ["path", "content"]
                }
              }
            },
            required: ["summary", "findings", "nextAction", "requestedCommands", "requestedFileWrites"]
          },
          strict: true
        }
      }
    });

    const parsed = normalizeStageArtifact(JSON.parse(response.output_text) as StageJsonArtifact);

    return {
      summary: parsed.summary,
      requestedCommands: parsed.requestedCommands,
      requestedFileWrites: parsed.requestedFileWrites,
      artifact: {
        provider: this.id,
        model,
        modelTier: input.modelTier ?? "standard",
        responseId: response.id,
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
    const response = await this.client.responses.create({
      model: this.model,
      input: [
        {
          role: "system",
          content: [
            "Summarize one project file for future coding-agent context retrieval.",
            "Return concise JSON only.",
            "Emphasize purpose, public interfaces, commands, constraints, and when an agent should read this file."
          ].join(" ")
        },
        {
          role: "user",
          content: buildFileSummaryPrompt(input)
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "file_summary_result",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              summary: { type: "string" },
              keyFacts: {
                type: "array",
                items: { type: "string" }
              },
              likelyUseWhen: {
                type: "array",
                items: { type: "string" }
              }
            },
            required: ["summary", "keyFacts", "likelyUseWhen"]
          },
          strict: true
        }
      }
    });

    const parsed = normalizeFileSummaryArtifact(JSON.parse(response.output_text) as FileSummaryJsonArtifact);
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
        responseId: response.id,
        sourceUri: input.sourceUri,
        refined: true,
        keyFacts: parsed.keyFacts,
        likelyUseWhen: parsed.likelyUseWhen
      }
    };
  }

  private resolveModelForTier(tier: StageExecutionInput["modelTier"]): string {
    if (!tier) {
      return this.model;
    }
    return process.env[`OPENAI_MODEL_${tier.toUpperCase()}`] || this.model;
  }
}
