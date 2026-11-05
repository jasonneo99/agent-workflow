import { z } from "zod/v3";

export const freshRunFamilyToolSchema = {
  relatedRunId: z.string().uuid().optional().describe("Exact earlier run of the same task to group in queue history. Does not reuse execution authority or results."),
  relatedRunReason: z.string().trim().min(1).max(2000).optional().describe("Why this fresh attempt belongs to that task family. Required with relatedRunId.")
};

export function appendFreshRunFamilyArgs(args: string[], input: {relatedRunId?: string; relatedRunReason?: string}): void {
  if (input.relatedRunId === undefined && input.relatedRunReason === undefined) return;
  const parsed = z.object({relatedRunId: z.string().uuid(), relatedRunReason: z.string().trim().min(1).max(2000)}).parse(input);
  args.push("--related-to", parsed.relatedRunId.toLowerCase(), "--related-reason", parsed.relatedRunReason);
}
