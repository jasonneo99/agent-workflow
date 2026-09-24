import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { redactDiagnosticData } from "./diagnostics.js";

export function createMcpLogger(logPath: string): {
  append: (event: string, data: Record<string, unknown>) => Promise<void>;
  appendSyncSafe: (event: string, data: Record<string, unknown>) => void;
} {
  const line = (event: string, data: Record<string, unknown>): string =>
    `${JSON.stringify({ ts: new Date().toISOString(), event, ...redactDiagnosticData(data) })}\n`;
  return {
    async append(event, data) {
      try {
        await fs.mkdir(path.dirname(logPath), { recursive: true });
        await fs.appendFile(logPath, line(event, data), "utf8");
      } catch {
        // MCP uses stdout for the protocol; logging failures must stay silent.
      }
    },
    appendSyncSafe(event, data) {
      try {
        fsSync.mkdirSync(path.dirname(logPath), { recursive: true });
        fsSync.appendFileSync(logPath, line(event, data), "utf8");
      } catch {
        // Best-effort process-exit breadcrumb only.
      }
    }
  };
}
