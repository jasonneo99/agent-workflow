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
  await Promise.all([
    fs.writeFile(jsonPath, `${JSON.stringify(proposalSet, null, 2)}\n`, "utf8"),
    fs.writeFile(markdownPath, formatLearningProposalMarkdown(proposalSet), "utf8")
  ]);
  return { directory, jsonPath, markdownPath };
}
