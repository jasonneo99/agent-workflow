import { execFile } from 'node:child_process';
import net from 'node:net';
import { promisify } from 'node:util';
import pg from 'pg';

const execFileAsync = promisify(execFile);

export type ProbeStatus = 'pass' | 'fail' | 'unknown';
export interface ProbeLayer { status: ProbeStatus; detail: string; code?: string | null }
export interface PostgresFixtureReadiness {
  ready: boolean;
  endpoint: string;
  portOwnership: ProbeLayer;
  protocolHandshake: ProbeLayer;
  containerHealth: ProbeLayer;
  authentication: ProbeLayer;
  schemaReadiness: ProbeLayer;
  missingRelations: string[];
  diagnosticLogs: string[];
  acceptance: 'transaction-verified' | 'not-verified';
}

interface ProbeClient {
  connect(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
}

export interface PostgresFixtureProbeDependencies {
  tcp?: (host: string, port: number, timeoutMs: number) => Promise<ProbeLayer>;
  protocol?: (host: string, port: number, timeoutMs: number) => Promise<ProbeLayer>;
  client?: (connectionString: string, timeoutMs: number) => ProbeClient;
  container?: (timeoutMs: number) => Promise<{ layer: ProbeLayer; logs: string[] }>;
}

function safeError(error: unknown): { message: string; code: string | null } {
  const value = error as { message?: unknown; code?: unknown };
  return {
    message: String(value?.message ?? error).replace(/postgres(?:ql)?:\/\/[^\s@]+@/giu, 'postgres://[credentials]@').slice(0, 500),
    code: typeof value?.code === 'string' ? value.code.slice(0, 32) : null,
  };
}

async function tcpProbe(host: string, port: number, timeoutMs: number): Promise<ProbeLayer> {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    const finish = (layer: ProbeLayer) => { socket.destroy(); resolve(layer); };
    socket.setTimeout(timeoutMs, () => finish({ status: 'fail', detail: 'TCP port did not accept a connection before the bounded timeout.', code: 'tcp-timeout' }));
    socket.once('connect', () => finish({ status: 'pass', detail: 'TCP endpoint accepted a connection; this proves port ownership, not PostgreSQL readiness.' }));
    socket.once('error', error => { const safe = safeError(error); finish({ status: 'fail', detail: safe.message, code: safe.code ?? 'tcp-error' }); });
  });
}

async function postgresProtocolProbe(host: string, port: number, timeoutMs: number): Promise<ProbeLayer> {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (layer: ProbeLayer) => { if (settled) return; settled = true; socket.destroy(); resolve(layer); };
    socket.setTimeout(timeoutMs, () => finish({ status: 'fail', detail: 'Endpoint accepted TCP but did not answer a PostgreSQL SSLRequest.', code: 'protocol-timeout' }));
    socket.once('connect', () => {
      const request = Buffer.alloc(8);
      request.writeInt32BE(8, 0);
      request.writeInt32BE(80877103, 4);
      socket.write(request);
    });
    socket.once('data', data => {
      const response = data.subarray(0, 1).toString('ascii');
      finish(response === 'S' || response === 'N'
        ? { status: 'pass', detail: `Endpoint answered the PostgreSQL startup protocol (${response === 'S' ? 'SSL supported' : 'SSL not supported'}).` }
        : { status: 'fail', detail: 'Endpoint answered TCP with a non-PostgreSQL startup response.', code: 'protocol-mismatch' });
    });
    socket.once('error', error => { const safe = safeError(error); finish({ status: 'fail', detail: safe.message, code: safe.code ?? 'protocol-error' }); });
    socket.once('end', () => finish({ status: 'fail', detail: 'Endpoint closed during the PostgreSQL startup handshake.', code: 'protocol-closed' }));
  });
}

async function projectContainerProbe(timeoutMs: number) {
  try {
    const status = await execFileAsync('docker', ['compose', '-f', 'infra/docker-compose.yml', 'ps', 'postgres', '--format', 'json'], { timeout: timeoutMs, maxBuffer: 64_000 });
    const output = status.stdout.trim();
    const healthy = /"State"\s*:\s*"running"|"Health"\s*:\s*"healthy"/iu.test(output);
    let logs: string[] = [];
    try {
      const result = await execFileAsync('docker', ['compose', '-f', 'infra/docker-compose.yml', 'logs', '--no-color', '--tail', '40', 'postgres'], { timeout: timeoutMs, maxBuffer: 64_000 });
      logs = result.stdout.split(/\r?\n/u).filter(Boolean).slice(-40).map(line => line.slice(0, 1000));
    } catch (error) {
      logs = [`Container log collection failed: ${safeError(error).message}`];
    }
    return { layer: { status: healthy ? 'pass' : 'fail', detail: healthy ? 'Project-owned PostgreSQL container reports running or healthy.' : 'Project-owned PostgreSQL container is absent or not running.', code: healthy ? null : 'container-not-running' }, logs };
  } catch (error) {
    const safe = safeError(error);
    return { layer: { status: 'unknown' as const, detail: `Container evidence unavailable: ${safe.message}`, code: safe.code }, logs: [] };
  }
}

export async function probePostgresFixtureReadiness(input: {
  connectionString: string;
  requiredRelations?: string[];
  timeoutMs?: number;
  inspectProjectContainer?: boolean;
  dependencies?: PostgresFixtureProbeDependencies;
}): Promise<PostgresFixtureReadiness> {
  const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 3_000, 250), 10_000);
  let url: URL;
  try { url = new URL(input.connectionString); } catch {
    const invalid = { status: 'fail' as const, detail: 'Database URL is invalid.', code: 'invalid-url' };
    return { ready: false, endpoint: 'invalid', portOwnership: invalid, protocolHandshake: invalid, containerHealth: { status: 'unknown', detail: 'Container not inspected.' }, authentication: invalid, schemaReadiness: invalid, missingRelations: [], diagnosticLogs: [], acceptance: 'not-verified' };
  }
  const host = url.hostname;
  const port = Number(url.port || 5432);
  const endpoint = `${host}:${port}/${url.pathname.replace(/^\//u, '') || '(default)'}`;
  const deps = input.dependencies ?? {};
  const portOwnership = await (deps.tcp ?? tcpProbe)(host, port, timeoutMs);
  const protocolHandshake = portOwnership.status === 'pass'
    ? await (deps.protocol ?? postgresProtocolProbe)(host, port, timeoutMs)
    : { status: 'unknown' as const, detail: 'Protocol was not attempted because the TCP endpoint is unavailable.', code: 'tcp-unavailable' };
  const container = input.inspectProjectContainer
    ? await (deps.container ?? projectContainerProbe)(timeoutMs)
    : { layer: { status: 'unknown' as const, detail: 'Container inspection was not requested; no runtime was changed.' }, logs: [] as string[] };
  let authentication: ProbeLayer = { status: 'unknown', detail: 'Authentication was not attempted because PostgreSQL protocol readiness was not established.' };
  let schemaReadiness: ProbeLayer = { status: 'unknown', detail: 'Schema was not inspected because authentication was not established.' };
  let missingRelations: string[] = [];
  if (protocolHandshake.status === 'pass') {
    const client = (deps.client ?? ((connectionString, boundedTimeout) => new pg.Client({ connectionString, connectionTimeoutMillis: boundedTimeout }) as unknown as ProbeClient))(input.connectionString, timeoutMs);
    try {
      await client.connect();
      authentication = { status: 'pass', detail: 'PostgreSQL authentication and database selection succeeded.' };
      await client.query('begin read only');
      const required = [...new Set(input.requiredRelations ?? [])].filter(value => /^[a-z_][a-z0-9_]*$/u.test(value)).slice(0, 32);
      if (required.length) {
        const result = await client.query('select name, to_regclass(name)::text as relation from unnest($1::text[]) name', [required]);
        missingRelations = result.rows.filter(row => !row.relation).map(row => String(row.name));
      }
      await client.query('select 1 as transaction_probe');
      await client.query('rollback');
      schemaReadiness = missingRelations.length
        ? { status: 'fail', detail: `Required schema relations are missing: ${missingRelations.join(', ')}.`, code: 'schema-missing' }
        : { status: 'pass', detail: required.length ? 'Required schema relations and a bounded read-only transaction succeeded.' : 'A bounded authenticated read-only transaction succeeded; no schema relations were requested.' };
    } catch (error) {
      const safe = safeError(error);
      const credentialFailure = safe.code === '28P01' || safe.code === '28000';
      if (authentication.status === 'pass') {
        schemaReadiness = { status: 'fail', detail: safe.message, code: safe.code ?? 'transaction-failed' };
      } else {
        authentication = { status: 'fail', detail: credentialFailure ? 'PostgreSQL rejected the configured credentials.' : safe.message, code: credentialFailure ? 'credential-rejected' : safe.code ?? 'connection-failed' };
        schemaReadiness = { status: 'unknown', detail: 'Schema was not inspected because authentication or database selection failed.' };
      }
      try { await client.query('rollback'); } catch { /* rollback evidence is secondary to the classified failure */ }
    } finally {
      try { await client.end(); } catch { /* diagnostic cleanup must not mask the classified failure */ }
    }
  }
  const containerBlocks = input.inspectProjectContainer && container.layer.status === 'fail';
  const ready = portOwnership.status === 'pass' && protocolHandshake.status === 'pass' && authentication.status === 'pass' && schemaReadiness.status === 'pass' && !containerBlocks;
  return { ready, endpoint, portOwnership, protocolHandshake, containerHealth: container.layer, authentication, schemaReadiness, missingRelations, diagnosticLogs: container.logs, acceptance: ready ? 'transaction-verified' : 'not-verified' };
}
