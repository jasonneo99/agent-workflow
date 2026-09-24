import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

test("stage authority renewal remains fenced by live worker ownership", () => {
  const source = readFileSync(new URL("./stage-authority.ts", import.meta.url), "utf8");
  assert.match(source, /await input\.assertLeaseOwned\(\);[\s\S]+issueStageAuthorityGrant/u);
  assert.match(source, /Date\.parse\(grant\.expires_at\)[\s\S]+await renew\(\)/u);
  assert.match(source, /assertStageAuthority\(\{ grant: grant!, mutation \}\)/u);
});
