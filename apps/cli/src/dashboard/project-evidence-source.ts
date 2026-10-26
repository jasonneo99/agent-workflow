import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { safeEvidencePath, type EvidenceNode } from "../../../../packages/project-evidence/src/index.js";

/** Resolve an indexed target only; never follow a legacy index outside its root. */
export async function renderEvidenceSource(project: string, node: EvidenceNode): Promise<string> {
  if (node.target.type !== "file" || !safeEvidencePath(node.target.value)) throw new Error("Invalid evidence source");
  const root = await fs.realpath(project);
  const target = await fs.realpath(path.resolve(root, node.target.value));
  if (!target.startsWith(root + path.sep)) throw new Error("Evidence source leaves project");
  if (target !== path.resolve(root, node.target.value)) throw new Error("Evidence preview does not follow symbolic links");
  const handle = await fs.open(target, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 200_000) throw new Error("Evidence preview exceeds limit");
    const raw = await handle.readFile();
    if (raw.length > 200_000 || raw.includes(0)) throw new Error("Evidence preview is not bounded text");
    const esc = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
    const changed = createHash("sha256").update(raw).digest("hex") !== node.source.hash;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Evidence source</title><style>body{font:16px/1.6 system-ui;padding:24px}pre{white-space:pre-wrap;overflow-wrap:anywhere}span:target{background:#ffe19a}</style></head><body><a href="/studio/context?project=${encodeURIComponent(project)}&node=${node.id}">Back to evidence</a><h1>${esc(node.target.value)}</h1><p>${changed ? "Source changed since indexing. This preview is current disk text; indexed claims may be stale." : "Source hash matches this indexed evidence."}</p><pre>${raw.toString("utf8").split("\n").map((line, i) => `<span id="line-${i + 1}">${i + 1}: ${esc(line)}</span>`).join("\n")}</pre></body></html>`;
  } finally { await handle.close(); }
}
