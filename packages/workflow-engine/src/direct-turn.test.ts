import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import { loadProjectConfig } from "../../agent-registry/src/loaders.js";
import { createDevSession, listDevSessionTurns, verifyDevSessionReceiptChain } from "../../storage/src/dev-sessions.js";
import { chunkTextForStreaming, runDirectTurn, type DevTurnEvent } from "./direct-turn.js";

const projectDir = fileURLToPath(new URL("../../../templates/project", import.meta.url));

test("chunkTextForStreaming splits long text into bounded chunks", () => {
  const chunks = chunkTextForStreaming("word ".repeat(500), 400);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 400));
  assert.equal(chunks.join(" ").replace(/\s+/g, " ").trim(), "word ".repeat(500).trim());
  assert.deepEqual(chunkTextForStreaming(""), []);
});

test("a direct turn with the mock provider completes and defers file writes without touching disk", async () => {
  const project = await loadProjectConfig(projectDir);
  const session = await createDevSession({ projectRootUri: projectDir, provider: "mock", title: "Direct turn test" });
  const events: DevTurnEvent[] = [];
  const probePath = path.join(projectDir, "src/dev-mode-probe.txt");
  await fs.rm(probePath, { force: true });

  const result = await runDirectTurn({
    session,
    projectDir,
    project,
    message: "Please draft [write-file:src/dev-mode-probe.txt::hello dev mode]",
    toolsEnabled: false,
    onEvent: (event) => {
      events.push(event);
    }
  });

  assert.match(result.summary, /Dev mode agent completed stage dev-turn for workflow dev-mode\./);
  assert.equal(result.iterations, 1);
  assert.deepEqual(result.deferredActions, [
    { kind: "file_write", target: "src/dev-mode-probe.txt", status: "deferred" }
  ]);
  assert.equal(events[0].type, "turn_started");
  assert.ok(events.some((event) => event.type === "token"));
  assert.ok(
    events.some(
      (event) => event.type === "tool_call" && event.tool === "file_write" && event.target === "src/dev-mode-probe.txt"
    )
  );
  assert.equal(events.at(-1)?.type, "turn_completed");

  // The proposed write was recorded, never applied.
  await assert.rejects(fs.stat(probePath), /ENOENT/);
  const turns = await listDevSessionTurns(session.id);
  assert.deepEqual(
    turns.map((turn) => turn.role),
    ["user", "assistant"]
  );
  assert.equal(turns[1].status, "completed");
  assert.equal(turns[1].content, result.summary);
  const verification = await verifyDevSessionReceiptChain(session.id);
  assert.equal(verification.valid, true);
  assert.ok(verification.checked >= 3);
});

test("a plain direct turn completes with no deferred actions", async () => {
  const project = await loadProjectConfig(projectDir);
  const session = await createDevSession({ projectRootUri: projectDir, provider: "mock", title: "Plain turn test" });
  const events: DevTurnEvent[] = [];
  const result = await runDirectTurn({
    session,
    projectDir,
    project,
    message: "Summarize the project in one sentence.",
    toolsEnabled: false,
    onEvent: (event) => {
      events.push(event);
    }
  });
  assert.deepEqual(result.deferredActions, []);
  assert.equal(events.at(-1)?.type, "turn_completed");
});
