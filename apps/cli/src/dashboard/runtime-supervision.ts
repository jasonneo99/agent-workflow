import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export type RuntimeSupervision = { adapter: 'systemd' | 'launchagent'; status: string; detail: string; mcpRequired: boolean };
/** Explicit deployment contract plus observed unit state; missing probes never imply health. */
export async function inspectRuntimeSupervision(input: {
  env?: NodeJS.ProcessEnv; platform?: string; legacyStatus: string;
  probe?: (unit: string) => Promise<string>;
}): Promise<RuntimeSupervision> {
  const env = input.env ?? process.env;
  const mcpRequired = env.AGENTFLOW_MCP_REQUIRED !== 'false';
  if (env.AGENTFLOW_SUPERVISION !== 'systemd') return { adapter: 'launchagent', status: input.legacyStatus, detail: `Local supervisor is ${input.legacyStatus}.`, mcpRequired };
  if ((input.platform ?? process.platform) !== 'linux') return { adapter: 'systemd', status: 'unknown', detail: 'Systemd supervision was configured on an unsupported host.', mcpRequired };
  const probe = input.probe ?? (async (unit) => (await exec('systemctl', ['--user', 'show', unit, '--property=ActiveState', '--value'], { timeout: 1500, maxBuffer: 4096 })).stdout.trim());
  try {
    const units = ['agent-workflow-dashboard.service', 'agent-workflow-worker.service', 'agent-workflow-learning.service'];
    const states = await Promise.all(units.map(probe));
    const status = states.every((state) => state === 'active') ? 'running' : 'degraded';
    return { adapter: 'systemd', status, detail: units.map((unit, i) => `${unit}: ${states[i] || 'unknown'}`).join('; '), mcpRequired };
  } catch { return { adapter: 'systemd', status: 'unknown', detail: 'Could not verify user systemd services.', mcpRequired }; }
}
