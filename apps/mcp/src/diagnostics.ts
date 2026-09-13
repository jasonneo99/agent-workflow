import { createHash } from "node:crypto";

export function shortDiagnosticHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function redactDiagnosticData(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [
    key,
    /(?:key|token|secret|password|databaseUrl|redisUrl)/i.test(key) ? "[redacted]" : value
  ]));
}
