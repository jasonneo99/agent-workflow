import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { EvidenceNode } from "../../../../packages/project-evidence/src/index.js";
import { renderEvidenceSource } from "./project-evidence-source.js";
test("source preview verifies hash, escapes text, and rejects symlinks and oversized files", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "evidence-preview-")));
  const content = "# Source\n<script>unsafe</script>";
  const node: EvidenceNode = { id: "abc", kind: "source", title: "source.md", source: { table: "project_files", key: "source.md", hash: createHash("sha256").update(content).digest("hex") }, target: { type: "file", value: "source.md" }, observedAt: null, freshness: "unverified", confidence: "recorded", authority: "none" };
  try {
    await fs.writeFile(path.join(root,"source.md"), content);
    const html = await renderEvidenceSource(root,node);
    assert.match(html,/hash matches/); assert.match(html,/&lt;script&gt;/); assert.match(html,/id="line-2"/);
    await fs.writeFile(path.join(root,"source.md"),"Changed");
    assert.match(await renderEvidenceSource(root,node),/changed since indexing/);
    await fs.symlink(path.join(root,"source.md"),path.join(root,"alias.md"));
    await assert.rejects(renderEvidenceSource(root,{...node,target:{type:"file",value:"alias.md"}}),/symbolic links/);
    await fs.writeFile(path.join(root,"source.md"),"x".repeat(200001));
    await assert.rejects(renderEvidenceSource(root,node),/limit/);
    await assert.rejects(renderEvidenceSource(root,{...node,target:{type:"file",value:"../secret"}}),/Invalid/);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
