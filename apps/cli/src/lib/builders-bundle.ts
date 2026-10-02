import type { CliContext } from "./context.js";
import { exists } from "./builders-shared.js";
import { loadCommittedBundleManifest } from "../../../../packages/agent-registry/src/manifest.js";
import { type ProjectBundleState } from "../../../../packages/bundle-trust/src/index.js";
import fs from "node:fs/promises";
import path from "node:path";

export async function writeProjectBundleState(ctx: CliContext, projectDir: string, force: boolean): Promise<{ relativePath: string; status: "written" | "skipped" }> {
  const manifest = await loadCommittedBundleManifest(ctx.rootDir);
  if (!manifest) throw new Error("Bundle manifest is missing.");
  const filePath = path.join(projectDir, ".agent-workflow", "bundle-state.json");
  const relativePath = path.relative(projectDir, filePath);
  if (!force && await exists(filePath)) {
    return { relativePath, status: "skipped" };
  }
  const state: ProjectBundleState = {
    schemaVersion: 1,
    bundle: {
      id: manifest.bundle.id,
      version: manifest.bundle.version,
      checksum: manifest.checksum.value,
      recordedAt: new Date().toISOString()
    }
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return { relativePath, status: "written" };
}
