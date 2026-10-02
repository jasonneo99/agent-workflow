import fs from "node:fs/promises";
import path from "node:path";
import type { LearningProposalSet } from "../../learning-governance/src/index.js";
import { formatLearningProposalMarkdown } from "./index.js";

export type LearningProposalFileSet = {
  directory: string;
  jsonPath: string;
  markdownPath: string;
};

export async function writeLearningProposalFiles(
  projectDir: string,
  proposalSet: LearningProposalSet
): Promise<LearningProposalFileSet> {
  const projectRoot = path.resolve(projectDir);
  const directory = path.resolve(projectRoot, ".agent-workflow", "learning");
  if (!directory.startsWith(`${projectRoot}${path.sep}`)) {
    throw new Error(`Learning proposal output must remain inside the project: ${directory}`);
  }

  const jsonPath = path.join(directory, "proposals.json");
  const markdownPath = path.join(directory, "proposals.md");
  await fs.mkdir(directory, { recursive: true });
  // Atomic: write to temp files then rename, so concurrent readers never
  // observe partially-written proposals.
  const writeAtomic = async (finalPath: string, content: string) => {
    const tmpPath = `${finalPath}.tmp.${process.pid}`;
    await fs.writeFile(tmpPath, content, "utf8");
    await fs.rename(tmpPath, finalPath);
  };
  await Promise.all([
    writeAtomic(jsonPath, `${JSON.stringify(proposalSet, null, 2)}\n`),
    writeAtomic(markdownPath, formatLearningProposalMarkdown(proposalSet))
  ]);
  return { directory, jsonPath, markdownPath };
}
