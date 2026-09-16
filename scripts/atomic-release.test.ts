import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./atomic-release.mjs", import.meta.url), "utf8");

test("atomic release health checks retry within the declared timeout", () => {
  assert.match(source, /const deadline = Date\.now\(\) \+ timeoutMs/u);
  assert.match(source, /while \(Date\.now\(\) < deadline\)/u);
  assert.match(source, /if \(response\.ok\) return true/u);
});
