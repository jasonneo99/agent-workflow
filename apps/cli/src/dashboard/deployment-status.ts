import {readFileSync, statSync} from 'node:fs';

export function deploymentStatus(file = process.env.AGENTFLOW_DEPLOYMENT_STATUS_PATH, now = Date.now()): Record<string, unknown> {
  if (!file) return {configured: false};
  try {
    if (statSync(file).size > 16_384) throw new Error('oversize');
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const result: Record<string, unknown> = {configured: true};
    for (const key of ['phase', 'sourceRevision', 'installedRevision', 'lastAttemptAt', 'updatedAt', 'blocker', 'commitsBehind']) {
      const value = raw[key];
      if (key.endsWith('Revision')) { if (typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)) result[key] = value; }
      else if (key === 'commitsBehind') { if (Number.isSafeInteger(value) && value >= 0) result[key] = value; }
      else if (typeof value === 'string') result[key] = value.slice(0, 240);
    }
    const updated = Date.parse(String(result.updatedAt));
    result.stale = !Number.isFinite(updated) || now - updated > 300_000 || updated > now + 30_000;
    return result;
  } catch { return {configured: true, stale: true, phase: 'status unavailable'}; }
}

export function deploymentStatusWidget(): string {
  return `<aside id="deployment-freshness" hidden style="font-size:12px;padding:8px;overflow-wrap:anywhere" aria-live="polite"></aside><script>(function(){const box=document.getElementById('deployment-freshness');async function refresh(){try{const r=await fetch('/api/deployment-status',{cache:'no-store'});if(!r.ok)return;const s=await r.json();if(!s.configured)return;box.hidden=false;const short=v=>typeof v==='string'?v.slice(0,7):'unknown';box.textContent='Deployment: '+(s.stale?'status stale':s.phase||'unknown')+' · local '+short(s.sourceRevision)+' · installed '+short(s.installedRevision)+(Number.isInteger(s.commitsBehind)?' · '+s.commitsBehind+' commits behind':'')+(s.lastAttemptAt?' · last attempt '+s.lastAttemptAt:'')+(s.blocker?' · '+s.blocker:'');}catch{box.hidden=false;box.textContent='Deployment status unavailable';}}refresh();setInterval(refresh,15000)})();</script>`;
}
