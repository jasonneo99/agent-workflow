import path from "node:path";
import type { Command } from "commander";
import { loadProjectConfig } from "../../../../packages/agent-registry/src/loaders.js";
import { checkSourceSizeRatchet, scanRepositoryMaintenance, writeRepositoryMaintenanceReceipt } from "../../../../packages/repository-maintenance/src/index.js";

export function registerRepositoryMaintenanceCommand(program: Command): void {
  program
    .command("repository-maintenance")
    .description("Scan repository hygiene and security risks and write a visible local receipt")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--check", "fail when a ratcheted source file grows beyond its baseline")
    .option("--json", "print JSON")
    .action(async (options: { project: string; check?: boolean; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      await loadProjectConfig(projectDir);
      const report = await scanRepositoryMaintenance(projectDir);
      const receipt = await writeRepositoryMaintenanceReceipt(projectDir, report);
      const ratchet = options.check ? await checkSourceSizeRatchet(projectDir) : null;
      if (options.json) console.log(JSON.stringify({ ...report, ratchet, receipt: path.relative(projectDir, receipt) }, null, 2));
      else console.log([`Repository maintenance: ${report.filesScanned} files`, `Hygiene: ${report.summary.hygiene}; security: ${report.summary.security}; errors: ${report.summary.errors}`, ratchet ? `Size ratchet: ${ratchet.passed ? "pass" : `fail (${ratchet.regressions.length} regression(s))`}` : "", `Receipt: ${path.relative(projectDir, receipt)}`].filter(Boolean).join("\n"));
      if (ratchet && !ratchet.passed) process.exitCode = 1;
    });
}
