import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDevSessionApproval } from "../../../../packages/storage/src/dev-sessions.js";
import { registerDevSessionTools } from "./dev-sessions.js";

const templateProjectDir = fileURLToPath(new URL("../../../../templates/project", import.meta.url));
const unknownId = "00000000-0000-0000-0000-000000000000";

type ToolCallResult = Awaited<ReturnType<Client["callTool"]>>;

async function withDevTools(check: (client: Client) => Promise<void>): Promise<void> {
  const server = new McpServer({ name: "synthetic-dev-sessions", version: "1" });
  registerDevSessionTools(server);
  const client = new Client({ name: "synthetic-dev-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await check(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function resultText(result: ToolCallResult): string {
  const content = result.content as Array<{ type: string; text: string }> | undefined;
  const first = content?.[0];
  assert.ok(first && first.type === "text", "tool result carries text content");
  return first.text;
}

function resultJson<T>(result: ToolCallResult): T {
  assert.notEqual(result.isError, true, resultText(result));
  return JSON.parse(resultText(result)) as T;
}

function resultError(result: ToolCallResult): string {
  assert.equal(result.isError, true, resultText(result));
  return resultText(result);
}

async function callJson<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  return resultJson<T>(await client.callTool({ name, arguments: args }));
}

async function callError(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  return resultError(await client.callTool({ name, arguments: args }));
}

async function scratchProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-mcp-dev-"));
  await fs.cp(templateProjectDir, dir, { recursive: true });
  return dir;
}

test("Dev session tools are registered with the documented names and required inputs", async () => {
  await withDevTools(async (client) => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), [
      "agentflow_dev_session_create",
      "agentflow_dev_sessions_list",
      "agentflow_dev_session_get",
      "agentflow_dev_turn",
      "agentflow_dev_diff_decide",
      "agentflow_dev_approval_decide"
    ]);
    const required = (name: string): unknown =>
      tools.find((tool) => tool.name === name)?.inputSchema.required;
    assert.deepEqual(required("agentflow_dev_session_create"), ["project"]);
    assert.deepEqual(required("agentflow_dev_sessions_list"), undefined);
    assert.deepEqual(required("agentflow_dev_session_get"), ["sessionId"]);
    assert.deepEqual(required("agentflow_dev_turn"), ["sessionId", "message"]);
    assert.deepEqual(required("agentflow_dev_diff_decide"), ["sessionId", "diffId", "decision"]);
    assert.deepEqual(required("agentflow_dev_approval_decide"), ["sessionId", "approvalId", "decision"]);
  });
});

test("create, list, and get round-trip through the MCP tools", async () => {
  await withDevTools(async (client) => {
    const created = await callJson<{ session: { id: string; provider: string; title: string; projectRootUri: string } }>(
      client,
      "agentflow_dev_session_create",
      { project: templateProjectDir, provider: "mock", title: "MCP round-trip" }
    );
    assert.equal(created.session.provider, "mock");
    assert.equal(created.session.title, "MCP round-trip");
    assert.equal(created.session.projectRootUri, templateProjectDir);

    const listed = await callJson<{ sessions: Array<{ id: string }> }>(client, "agentflow_dev_sessions_list", {
      project: templateProjectDir
    });
    assert.ok(listed.sessions.some((session) => session.id === created.session.id));

    const unfiltered = await callJson<{ sessions: Array<{ id: string }> }>(
      client,
      "agentflow_dev_sessions_list",
      {}
    );
    assert.ok(unfiltered.sessions.some((session) => session.id === created.session.id));

    const detail = await callJson<{
      session: { id: string };
      turns: unknown[];
      diffs: unknown[];
      approvals: unknown[];
      hunks: unknown[];
    }>(client, "agentflow_dev_session_get", { sessionId: created.session.id });
    assert.equal(detail.session.id, created.session.id);
    assert.deepEqual(detail.turns, []);
    assert.deepEqual(detail.diffs, []);
    assert.deepEqual(detail.approvals, []);
    assert.deepEqual(detail.hunks, []);

    assert.match(
      await callError(client, "agentflow_dev_session_create", { project: "does/not/exist" }),
      /Unknown project directory/
    );
    assert.match(
      await callError(client, "agentflow_dev_session_create", {
        project: templateProjectDir,
        provider: "no-such-provider"
      }),
      /Unsupported provider adapter/
    );
    assert.match(
      await callError(client, "agentflow_dev_session_create", { project: "" }),
      /Missing project/
    );
    assert.match(
      await callError(client, "agentflow_dev_session_get", { sessionId: unknownId }),
      /Unknown dev session/
    );
  });
});

test("a turn to completion returns ordered events and proposes a diff without touching disk", async () => {
  const projectDir = await scratchProject();
  try {
    await withDevTools(async (client) => {
      const { session } = await callJson<{ session: { id: string } }>(client, "agentflow_dev_session_create", {
        project: projectDir,
        provider: "mock",
        title: "MCP turn test"
      });
      const result = await callJson<{
        turnId: string;
        stoppedReason: string;
        summary: string;
        iterations: number;
        diffIds: string[];
        events: Array<{ type: string; path?: string; diffId?: string }>;
      }>(client, "agentflow_dev_turn", {
        sessionId: session.id,
        message: "Draft the file [write-file:src/mcp-dev-probe.txt::hello mcp dev]"
      });
      assert.equal(result.stoppedReason, "completed");
      assert.equal(result.events[0]?.type, "turn_started");
      assert.ok(result.events.some((event) => event.type === "token"));
      assert.ok(
        result.events.some(
          (event) => event.type === "diff_proposed" && event.path === "src/mcp-dev-probe.txt"
        )
      );
      assert.equal(result.events.at(-1)?.type, "turn_completed");
      assert.equal(result.diffIds.length, 1);
      assert.match(result.summary, /Dev mode agent completed stage dev-turn/);

      await assert.rejects(fs.stat(path.join(projectDir, "src/mcp-dev-probe.txt")), /ENOENT/);
      const detail = await callJson<{
        turns: Array<{ role: string; status: string }>;
        diffs: Array<{ id: string; path: string; status: string; proposedContent: string }>;
      }>(client, "agentflow_dev_session_get", { sessionId: session.id });
      assert.deepEqual(detail.turns.map((turn) => turn.role), ["user", "assistant"]);
      assert.equal(detail.turns[1]?.status, "completed");
      assert.equal(detail.diffs.length, 1);
      assert.equal(detail.diffs[0].id, result.diffIds[0]);
      assert.equal(detail.diffs[0].path, "src/mcp-dev-probe.txt");
      assert.equal(detail.diffs[0].status, "proposed");
      assert.equal(detail.diffs[0].proposedContent, "hello mcp dev");

      assert.match(
        await callError(client, "agentflow_dev_turn", { sessionId: session.id, message: "   " }),
        /Missing message/
      );
      assert.match(
        await callError(client, "agentflow_dev_turn", { sessionId: unknownId, message: "hi" }),
        /Unknown dev session/
      );
    });
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

test("diff decide accepts and applies a proposed file and rejects a second one", async () => {
  const projectDir = await scratchProject();
  try {
    await withDevTools(async (client) => {
      const { session } = await callJson<{ session: { id: string } }>(client, "agentflow_dev_session_create", {
        project: projectDir,
        provider: "mock",
        title: "MCP diff decide test"
      });
      const { session: otherSession } = await callJson<{ session: { id: string } }>(
        client,
        "agentflow_dev_session_create",
        { project: projectDir, provider: "mock", title: "MCP other session" }
      );
      const turn = await callJson<{ diffIds: string[] }>(client, "agentflow_dev_turn", {
        sessionId: session.id,
        message: "Draft the file [write-file:src/mcp-dev-accept.txt::accepted content]"
      });
      const diffId = turn.diffIds[0];
      assert.ok(diffId);

      assert.match(
        await callError(client, "agentflow_dev_diff_decide", {
          sessionId: session.id,
          diffId,
          decision: "maybe"
        }),
        /accept or reject/
      );
      assert.match(
        await callError(client, "agentflow_dev_diff_decide", {
          sessionId: session.id,
          diffId,
          decision: "accept",
          hunkIndex: -1
        }),
        /non-negative integer/
      );
      assert.match(
        await callError(client, "agentflow_dev_diff_decide", {
          sessionId: session.id,
          diffId: unknownId,
          decision: "accept"
        }),
        /Unknown dev diff/
      );
      assert.match(
        await callError(client, "agentflow_dev_diff_decide", {
          sessionId: otherSession.id,
          diffId,
          decision: "accept"
        }),
        /does not belong to this session/
      );

      const accepted = await callJson<{
        diff: { status: string };
        appliedHunks: number[];
        rejectedHunks: number[];
        newHash: string | null;
      }>(client, "agentflow_dev_diff_decide", { sessionId: session.id, diffId, decision: "accept" });
      assert.deepEqual(accepted.appliedHunks, [0]);
      assert.deepEqual(accepted.rejectedHunks, []);
      assert.equal(accepted.diff.status, "accepted");
      assert.ok(accepted.newHash);
      assert.equal(
        (await fs.readFile(path.join(projectDir, "src/mcp-dev-accept.txt"), "utf8")).trim(),
        "accepted content"
      );

      const second = await callJson<{ diffIds: string[] }>(client, "agentflow_dev_turn", {
        sessionId: session.id,
        message: "Draft the file [write-file:src/mcp-dev-reject.txt::rejected content]"
      });
      const rejected = await callJson<{
        diff: { status: string };
        appliedHunks: number[];
        rejectedHunks: number[];
        newHash: string | null;
      }>(client, "agentflow_dev_diff_decide", {
        sessionId: session.id,
        diffId: second.diffIds[0],
        decision: "reject"
      });
      assert.deepEqual(rejected.appliedHunks, []);
      assert.deepEqual(rejected.rejectedHunks, [0]);
      assert.equal(rejected.diff.status, "rejected");
      assert.equal(rejected.newHash, null);
      await assert.rejects(fs.stat(path.join(projectDir, "src/mcp-dev-reject.txt")), /ENOENT/);
    });
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

test("approval decide approves with a resume hint and rejects with a null hint", async () => {
  await withDevTools(async (client) => {
    const { session } = await callJson<{ session: { id: string } }>(client, "agentflow_dev_session_create", {
      project: templateProjectDir,
      provider: "mock",
      title: "MCP approval decide test"
    });
    const { session: otherSession } = await callJson<{ session: { id: string } }>(
      client,
      "agentflow_dev_session_create",
      { project: templateProjectDir, provider: "mock", title: "MCP approval other session" }
    );
    const approval = await createDevSessionApproval({
      sessionId: session.id,
      turnId: null,
      actionType: "local_command",
      target: 'python3 -c "print(1)"',
      rationale: "Test approval.",
      policyDecision: { approvalRequired: true },
      payload: {},
      idempotencyKey: "mcp-approval-test-1"
    });
    const rejected = await createDevSessionApproval({
      sessionId: session.id,
      turnId: null,
      actionType: "local_command",
      target: 'python3 -c "print(2)"',
      rationale: "Test approval.",
      policyDecision: { approvalRequired: true },
      payload: {},
      idempotencyKey: "mcp-approval-test-2"
    });

    const decided = await callJson<{
      approval: { status: string };
      resumeHint: string | null;
    }>(client, "agentflow_dev_approval_decide", {
      sessionId: session.id,
      approvalId: approval.id,
      decision: "approved",
      actor: "mcp-test"
    });
    assert.equal(decided.approval.status, "approved");
    assert.match(decided.resumeHint ?? "", /Continue with the approved local_command/);

    const declined = await callJson<{
      approval: { status: string };
      resumeHint: string | null;
    }>(client, "agentflow_dev_approval_decide", {
      sessionId: session.id,
      approvalId: rejected.id,
      decision: "rejected"
    });
    assert.equal(declined.approval.status, "rejected");
    assert.equal(declined.resumeHint, null);

    assert.match(
      await callError(client, "agentflow_dev_approval_decide", {
        sessionId: session.id,
        approvalId: approval.id,
        decision: "approved"
      }),
      /already decided/
    );
    assert.match(
      await callError(client, "agentflow_dev_approval_decide", {
        sessionId: session.id,
        approvalId: approval.id,
        decision: "maybe"
      }),
      /approved or rejected/
    );
    assert.match(
      await callError(client, "agentflow_dev_approval_decide", {
        sessionId: session.id,
        approvalId: unknownId,
        decision: "approved"
      }),
      /Unknown dev approval/
    );
    assert.match(
      await callError(client, "agentflow_dev_approval_decide", {
        sessionId: otherSession.id,
        approvalId: approval.id,
        decision: "approved"
      }),
      /does not belong to this session/
    );
  });
});

test("a turn pauses for approval and resumes after the approval decision", async () => {
  const projectDir = await scratchProject();
  try {
    await withDevTools(async (client) => {
      const { session } = await callJson<{ session: { id: string } }>(client, "agentflow_dev_session_create", {
        project: projectDir,
        provider: "mock",
        title: "MCP approval pause test"
      });
      const command = 'python3 -c "print(approved)"';
      const paused = await callJson<{
        stoppedReason: string;
        awaitingApproval?: { approvalId: string; actionType: string; target: string };
        events: Array<{ type: string; approvalId?: string; actionType?: string; target?: string }>;
      }>(client, "agentflow_dev_turn", {
        sessionId: session.id,
        message: `Run this [request-command:${command}]`
      });
      assert.equal(paused.stoppedReason, "awaiting_approval");
      assert.ok(paused.awaitingApproval);
      assert.equal(paused.awaitingApproval.actionType, "local_command");
      assert.equal(paused.awaitingApproval.target, command);
      assert.ok(
        paused.events.some(
          (event) =>
            event.type === "turn_awaiting_approval" &&
            event.approvalId === paused.awaitingApproval?.approvalId
        )
      );

      const detail = await callJson<{
        approvals: Array<{ id: string; status: string }>;
        turns: Array<{ status: string }>;
      }>(client, "agentflow_dev_session_get", { sessionId: session.id });
      assert.equal(detail.approvals.length, 1);
      assert.equal(detail.approvals[0].status, "pending");
      assert.equal(detail.turns.at(-1)?.status, "awaiting_approval");

      const decided = await callJson<{ resumeHint: string | null }>(client, "agentflow_dev_approval_decide", {
        sessionId: session.id,
        approvalId: paused.awaitingApproval.approvalId,
        decision: "approved"
      });
      assert.match(decided.resumeHint ?? "", /Continue with the approved local_command/);

      const resumed = await callJson<{
        stoppedReason: string;
        events: Array<{ type: string; tool?: string; target?: string; status?: string }>;
      }>(client, "agentflow_dev_turn", {
        sessionId: session.id,
        message: `${decided.resumeHint} [request-command:${command}]`
      });
      assert.equal(resumed.stoppedReason, "completed");
      assert.ok(
        resumed.events.some(
          (event) =>
            event.type === "tool_call" &&
            event.tool === "local_command" &&
            event.target === command &&
            event.status === "executed"
        )
      );
    });
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});
