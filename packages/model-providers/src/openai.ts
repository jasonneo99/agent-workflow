import OpenAI from "openai";
import type { FileSummaryInput, FileSummaryOutput, ModelProvider, StageExecutionInput, StageExecutionOutput } from "./types.js";

interface OpenAIStageArtifact {
  summary: string;
  findings: string[];
  nextAction: string;
  requestedCommands: string[];
  requestedFileWrites: Array<{
    path: string;
    content: string;
  }>;
}

interface OpenAIFileSummaryArtifact {
  summary: string;
  keyFacts: string[];
  likelyUseWhen: string[];
}

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
    const response = await this.client.responses.create({
      model: this.model,
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
          content: this.buildPrompt(input)
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

    const parsed = JSON.parse(response.output_text) as OpenAIStageArtifact;

    return {
      summary: parsed.summary,
      requestedCommands: parsed.requestedCommands,
      requestedFileWrites: parsed.requestedFileWrites,
      artifact: {
        provider: this.id,
        model: this.model,
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
          content: [
            `File: ${input.sourceUri}`,
            "",
            "Deterministic summary:",
            input.deterministicSummary,
            "",
            "File content:",
            truncate(input.content, 12000)
          ].join("\n")
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

    const parsed = JSON.parse(response.output_text) as OpenAIFileSummaryArtifact;
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

  private buildPrompt(input: StageExecutionInput): string {
    return [
      `Workflow: ${input.workflowId}`,
      `Overall task: ${input.workflowTask}`,
      `Stage: ${input.stageId}`,
      `Stage goal: ${input.stageGoal}`,
      `Agent: ${input.agentName} (${input.agentId})`,
      "",
      "Agent instructions:",
      input.agentPrompt,
      "",
      "Project action policy:",
      formatActionPolicy(input.projectConfig),
      "",
      "Compiled project/workflow brief:",
      truncate(input.compiledBrief, 8000),
      "",
      "Prior stage receipts:",
      input.priorReceipts.length
        ? input.priorReceipts.map((receipt) => `- ${receipt.actionType} ${receipt.agentId}: ${receipt.summary}`).join("\n")
        : "None yet.",
      "",
      "Return JSON with:",
      "- summary: one or two sentences describing the stage result",
      "- findings: concrete observations, risks, or decisions",
      "- nextAction: the next useful workflow action",
      "- requestedCommands: exact commands from the allowed command policy only; do not use shell operators, pipes, redirects, variables, or command chaining; use [] when no command is necessary",
      "- requestedFileWrites: project-relative files under allowed write paths only, each with path and full content; use [] unless a file edit is necessary and keep content compact"
    ].join("\n");
  }
}

function formatActionPolicy(project: StageExecutionInput["projectConfig"]): string {
  return [
    `Allowed commands: ${project.actions.allowed_commands.join(" | ") || "none"}`,
    `Blocked commands: ${project.actions.blocked_commands.join(" | ") || "none"}`,
    `Allowed write paths: ${project.actions.allowed_write_paths.join(" | ") || "none"}`,
    `Blocked write paths: ${project.actions.blocked_write_paths.join(" | ") || "none"}`,
    `Command timeout: ${project.actions.command_timeout_ms}ms`,
    `Max write bytes: ${project.actions.max_write_bytes}`
  ].join("\n");
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n...[truncated ${value.length - maxLength} chars]`;
}
