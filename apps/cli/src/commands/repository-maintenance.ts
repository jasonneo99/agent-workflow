import path from "node:path";
import type { Command } from "commander";
import { loadProjectConfig } from "../../../../packages/agent-registry/src/loaders.js";
import { scanRepositoryMaintenance, writeRepositoryMaintenanceReceipt } from "../../../../packages/repository-maintenance/src/index.js";

export function registerRepositoryMaintenanceCommand(program: Command): void {
  program
    .command("repository-maintenance")
    .description("Scan repository hygiene and security risks and write a visible local receipt")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--json", "print JSON")
    .action(async (options: { project: string; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      await loadProjectConfig(projectDir);
      const report = await scanRepositoryMaintenance(projectDir);
      const receipt = await writeRepositoryMaintenanceReceipt(projectDir, report);
      if (options.json) console.log(JSON.stringify({ ...report, receipt: path.relative(projectDir, receipt) }, null, 2));
      else console.log([`Repository maintenance: ${report.filesScanned} files`, `Hygiene: ${report.summary.hygiene}; security: ${report.summary.security}; errors: ${report.summary.errors}`, `Receipt: ${path.relative(projectDir, receipt)}`].join("\n"));
    });
}
