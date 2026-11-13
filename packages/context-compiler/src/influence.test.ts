import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileContext, type CompileInput } from "./index.js";
import { influenceHash, type ContextInfluence } from "../../project-evidence/src/influence.js";
test("compiler attribution hashes the bytes actually included and preserves indexed source identity", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),"influence-compile-"));
  try {
    await fs.mkdir(path.join(root,".agent-workflow"));
    const decision = "# Decision\nUse project-only evidence\n";
    await fs.writeFile(path.join(root,".agent-workflow/decisions.md"),decision);
    let captured: ContextInfluence | undefined;
    const input = { task:"Explain sources",projectDir:root,project:{project:{name:"fixture",autonomy:1},actions:{allowed_commands:[],blocked_commands:[],allowed_write_paths:[],blocked_write_paths:[],approval_rules:[]}},workflow:{id:"fixture",name:"Fixture",lead:"test",stages:[]},agents:[],sourceSummaries:[{sourceUri:"requirements.md",summary:"R1",contentHash:"source-hash",updatedAt:"2026-01-01",tokenEstimate:1}],sourceExcerpts:[{sourceUri:"src/main.ts",content:"included",kind:"source_file",contentSha256:"whole-file-hash",truncated:true}],onInfluence:(value: ContextInfluence)=>{captured=value;} } as unknown as CompileInput;
    const text = await compileContext(input);
    assert.equal(captured?.contextHash,influenceHash(text));
    const file = captured?.references.find(ref=>ref.kind==="file");
    assert.equal(file?.includedHash,influenceHash(decision.trim())); assert.equal(file?.sourceHash,influenceHash(decision));
    const summary=captured?.references.find(ref=>ref.kind==="indexed_summary");
    assert.equal(summary?.sourceHash,"source-hash"); assert.equal(summary?.observedAt,"2026-01-01"); assert.equal(summary?.freshness,"unverified");
    assert.equal(captured?.references.find(ref=>ref.kind==="excerpt")?.truncated,true);
    assert.equal(captured?.graphStatus,"not_supplied");assert.deepEqual(captured?.graphRelationships,[]);
    assert.ok(!JSON.stringify(captured).includes("Use project-only evidence"));
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
