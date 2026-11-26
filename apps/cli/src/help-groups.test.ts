import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { Command } from "commander";
import { applyHelpGroups, HELP_GROUPS, OPERATOR_GROUP_TITLE } from "./lib/help-groups.js";

const run = promisify(execFile);
const cli = (...args: string[]) => run(process.execPath, ["--import", "tsx", "apps/cli/src/index.ts", ...args], { env: { ...process.env, DEFAULT_MODEL_PROVIDER: "mock" } });

test("root help groups everyday commands and hides the rest without removing any", async () => {
  const program = new Command("agentflow");
  for (const name of ["status", "context-hook", "run"]) program.command(name).description(`${name} description`).action(() => {});
  applyHelpGroups(program);
  const help = program.helpInformation();
  assert.match(help, /Run workflows:\n {2}run .*\n {2}status /u);
  assert.doesNotMatch(help, /context-hook/u);
  assert.match(help, /1 operator, hook and maintenance commands are not shown/u);
  assert.ok(program.commands.some(command => command.name() === "context-hook"), "hidden commands stay registered");
});

test("every grouped command exists and `commands` lists all registered commands", { timeout: 60_000 }, async () => {
  const listing = (await cli("commands")).stdout;
  for (const group of HELP_GROUPS) for (const name of group.commands) {
    assert.match(listing, new RegExp(`^ {2}${name}[ |]`, "mu"), `${group.title}: ${name} is registered`);
  }
  assert.match(listing, new RegExp(`^${OPERATOR_GROUP_TITLE}:$`, "mu"));
  for (const hidden of ["context-hook", "verify-receipts", "egress-log", "worker-host-trust"]) assert.match(listing, new RegExp(`^ {2}${hidden} `, "mu"));
  const root = (await cli("--help")).stdout;
  assert.doesNotMatch(root, /^ {2}context-hook /mu);
  assert.match((await cli("help", "context-hook")).stdout, /Usage: agentflow context-hook/u);
});
