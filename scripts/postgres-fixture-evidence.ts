import fs from 'node:fs/promises';
import path from 'node:path';
import type { PostgresFixtureReadiness, ProbeLayer } from './postgres-fixture-readiness.js';

export interface PostgresFixtureEvidence {
  schemaVersion: 1;
  kind: 'postgres-fixture-readiness';
  phase: 'preflight' | 'fixture' | 'cleanup';
  generatedAt: string;
  retention: { class: 'ci-diagnostic'; suggestedDays: 14; containsCredentials: false };
  report: PostgresFixtureReadiness;
  failure: string | null;
}

function redact(value: string): string {
  return value
    .replace(/postgres(?:ql)?:\/\/[^\s@]+@/giu, 'postgres://[credentials]@')
    .replace(/\b(password|secret|token|api[_-]?key)\s*[=:]\s*[^\s,;]+/giu, '$1=[redacted]')
    .slice(0, 2_000);
}

function cleanLayer(layer: ProbeLayer): ProbeLayer {
  return { ...layer, detail: redact(layer.detail), code: layer.code ? redact(layer.code) : layer.code };
}

export function sanitizePostgresFixtureReport(report: PostgresFixtureReadiness): PostgresFixtureReadiness {
  return {
    ...report,
    endpoint: report.endpoint.replace(/[^/]+@/u, '[credentials]@').slice(0, 300),
    portOwnership: cleanLayer(report.portOwnership),
    protocolHandshake: cleanLayer(report.protocolHandshake),
    containerHealth: cleanLayer(report.containerHealth),
    authentication: cleanLayer(report.authentication),
    schemaReadiness: cleanLayer(report.schemaReadiness),
    missingRelations: report.missingRelations.slice(0, 32).map(value => value.slice(0, 128)),
    diagnosticLogs: report.diagnosticLogs.slice(-40).map(redact),
  };
}

export function postgresFixtureSummary(phase: PostgresFixtureEvidence['phase'], report: PostgresFixtureReadiness): string {
  const layers = [
    ['port', report.portOwnership],
    ['protocol', report.protocolHandshake],
    ['container', report.containerHealth],
    ['auth', report.authentication],
    ['schema', report.schemaReadiness],
  ] as const;
  const failed = layers.filter(([, layer]) => layer.status === 'fail').map(([name]) => name);
  const unknown = layers.filter(([, layer]) => layer.status === 'unknown').map(([name]) => name);
  return `PostgreSQL fixture ${phase}: ${report.ready ? 'READY' : 'NOT READY'}; failed=${failed.join(',') || 'none'}; unknown=${unknown.join(',') || 'none'}; acceptance=${report.acceptance}.`;
}

export async function writePostgresFixtureEvidence(input: {
  directory?: string;
  phase: PostgresFixtureEvidence['phase'];
  report: PostgresFixtureReadiness;
  failure?: unknown;
  generatedAt?: string;
}): Promise<string | null> {
  if (!input.directory) return null;
  const evidence: PostgresFixtureEvidence = {
    schemaVersion: 1,
    kind: 'postgres-fixture-readiness',
    phase: input.phase,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    retention: { class: 'ci-diagnostic', suggestedDays: 14, containsCredentials: false },
    report: sanitizePostgresFixtureReport(input.report),
    failure: input.failure === undefined ? null : redact(input.failure instanceof Error ? input.failure.message : String(input.failure)),
  };
  await fs.mkdir(input.directory, { recursive: true });
  const file = path.join(input.directory, `postgres-fixture-${input.phase}.json`);
  await fs.writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return file;
}
