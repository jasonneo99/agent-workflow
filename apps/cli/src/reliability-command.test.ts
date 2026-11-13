import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const entry = fileURLToPath(new URL("./reliability-command.ts", import.meta.url));
function invoke(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", entry, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, DATABASE_URL: "postgres://invalid:invalid@127.0.0.1:1/invalid" },
  });
}

test("reliability help succeeds without storage or required intent arguments", () => {
  for (const args of [["--help"], ["-h"], ["intent", "acquire", "--help"],
    ["intent", "renew", "-h"], ["intent", "release", "--help"],
    ["intent", "list", "--help"], ["report", "--help"],
    ["chaos", "--evidence", "missing-evidence.json", "--help"]]) {
    const result = invoke(args);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /intent acquire --project/);
    assert.match(result.stdout, /--token <token>/);
    assert.equal(result.stderr, "");
  }
});

test("intent acquisition without help still requires arguments", () => {
  const result = invoke(["intent", "acquire"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--project is required/);
});
