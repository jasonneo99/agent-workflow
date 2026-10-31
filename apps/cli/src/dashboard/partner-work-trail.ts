/** Stable receipt identity is independent of refresh timing and display order. */
export function mergePartnerWorkSteps(previous: any[], incoming: any[], runId: string): any[] {
  const rows = new Map<string, any>(), uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
  for (const row of [...previous, ...incoming]) {
    if (!row || typeof row.id !== 'string' || !row.id.startsWith(runId + ':') || !uuid.test(row.id.slice(runId.length + 1)) || !Number.isFinite(Date.parse(row.at)) || typeof row.title !== 'string') continue;
    rows.set(row.id, { id: row.id, at: row.at, title: row.title.slice(0, 300), detail: typeof row.detail === 'string' ? row.detail.slice(0, 700) : '', agent: typeof row.agent === 'string' ? row.agent.slice(0, 100) : '', stage: typeof row.stage === 'string' ? row.stage.slice(0, 100) : '', kind: typeof row.kind === 'string' ? row.kind.slice(0, 40) : '', state: ['started','completed','failed','waiting','stopped','recorded'].includes(row.state) ? row.state : 'recorded' });
  }
  return [...rows.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)).slice(-400);
}

/** Browser-only reader. It never calls a worker, model, approval or mutation API. */
export function installPartnerWorkTrail(merge: typeof mergePartnerWorkSteps, onStop: (runId: string) => void) {
  const cache = new Map<string, any>(), uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
  let stopped = false;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; };
  const agentName = (id: string) => id.replaceAll('-', ' ').replace(/\b\w/g, (value: string) => value.toUpperCase());
  const draw = (state: any) => {
    const host = state.host; if (!host || host.isConnected === false) return;
    const data = state.report, live = !state.failed ? (data?.active ?? []).filter((task: any) => Date.parse(task.leaseExpiresAt) > Date.now()) : [], active = live.length > 0;
    clearTimeout(state.leaseTimer); if (active) state.leaseTimer = setTimeout(() => draw(state), Math.max(1, Math.min(...live.map((task: any) => Date.parse(task.leaseExpiresAt))) - Date.now() + 1));
    const drawKey = JSON.stringify([state.steps, data?.run?.status, live.map((task: any) => [task.agent,task.stage]), state.failed, state.hasOlder]);
    if (state.drawHost === host && state.drawKey === drawKey) return;
    state.drawHost = host; state.drawKey = drawKey;
    const focusedStep = host.contains(document.activeElement) ? (document.activeElement as HTMLElement)?.dataset?.workStep : undefined;
    const oldList = host.querySelector('.partner-work-steps'), top = oldList?.scrollTop ?? 0, follow = !oldList || oldList.scrollHeight - oldList.scrollTop - oldList.clientHeight < 70;
    host.replaceChildren(); host.className = 'partner-work-trail';
    const details = node('details'), heading = node('summary'), dot = node('span', '', 'partner-work-dot'), title = node('strong');
    dot.dataset.active = String(active); title.textContent = state.failed ? 'Live updates unavailable' : active ? agentName(live[0].agent) + ' is working' : data?.run?.status === 'blocked' ? 'Waiting for input' : data?.run?.status === 'failed' ? 'Work needs attention' : data?.run?.status === 'cancelled' ? 'Work stopped' : data?.run?.status === 'completed' ? 'Work finished' : data ? 'Waiting for recorded agent activity' : 'Connecting to agent activity…';
    heading.append(dot, title, node('small', state.steps.length + ' recorded steps')); details.append(heading); details.open = state.open ?? active;
    details.addEventListener('toggle', () => { state.open = details.open; });
    const list = node('ol', undefined, 'partner-work-steps'); list.setAttribute('aria-label', 'Step-by-step agent history');
    for (const step of state.steps) {
      const item = node('li'), disclosure = node('details'), line = node('summary'), mark = node('span', step.state === 'completed' ? '✓' : step.state === 'failed' ? '!' : step.state === 'waiting' ? '…' : '›', 'partner-work-mark');
      line.dataset.workStep = step.id;
      mark.dataset.state = step.state; line.append(mark, node('span', step.title)); disclosure.append(line);
      disclosure.append(node('small', agentName(step.agent) + (step.stage ? ' · ' + step.stage : '') + ' · ' + new Date(step.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })));
      if (step.detail) disclosure.append(node('p', step.detail)); disclosure.open = state.expanded.has(step.id); disclosure.addEventListener('toggle', () => disclosure.open ? state.expanded.add(step.id) : state.expanded.delete(step.id)); item.append(disclosure); list.append(item);
    }
    if (!state.steps.length) list.append(node('li', 'Waiting for the first recorded step.'));
    details.append(list);
    if (state.steps.length >= 400) details.append(node('p', 'Showing the latest 400 steps. Open the run for its full preserved history.'));
    else if (state.hasOlder) { const earlier = node('button', 'Load earlier steps'); earlier.type = 'button'; earlier.disabled = state.inflight; earlier.addEventListener('click', () => void load(state, true)); details.append(earlier); }
    if (state.failed) details.append(node('p', 'The last recorded steps are kept here. Reconnecting does not repeat any work.'));
    const link = node('a', 'Open run evidence'); link.href = '/run?id=' + state.runId; details.append(link);
    if (data && ['running','leased','queued'].includes(data.run.status)) { const stop = node('button', 'Stop this run'); stop.type = 'button'; stop.addEventListener('click', () => onStop(state.runId)); details.append(stop); }
    host.append(details); if (follow) list.scrollTop = list.scrollHeight; else list.scrollTop = top;
    if (focusedStep) host.querySelector('[data-work-step="' + focusedStep + '"]')?.focus({ preventScroll: true });
  };
  async function load(state: any, older = false) {
    clearTimeout(state.timer); state.timer = null;
    if (stopped || document.hidden || state.inflight || state.host?.isConnected === false || document.getElementById('queue-partner-overlay')?.hidden) return;
    state.inflight = true; const controller = new AbortController(); state.controller = controller;
    const deadline = setTimeout(() => controller.abort(), 12000), query = new URLSearchParams({ run: state.runId });
    if (older && state.before) query.set('before', state.before); else if (state.after) query.set('after', state.after);
    try {
      const response = await fetch('/api/partner-work-history?' + query, { cache: 'no-store', signal: controller.signal, headers: { accept: 'application/json', 'content-type': 'application/json', 'x-agentflow-queue-partner': '1' } });
      if (!response.ok) throw Error('History unavailable'); const report = await response.json();
      if (stopped || state.controller !== controller) return;
      if (report?.version !== 1 || report.authority !== 'evidence-only' || report.scope?.runId !== state.runId || !uuid.test(report.scope?.projectId) || state.projectId && state.projectId !== report.scope.projectId || report.run?.id !== state.runId || !Array.isArray(report.steps) || report.steps.length > 80 || !Array.isArray(report.active) || report.active.length > 5) throw Error('Invalid scoped work history');
      state.projectId = report.scope.projectId;
      state.steps = merge(state.steps, report.steps, state.runId); state.report = report; state.failed = false;
      if (!older) { state.after = report.after ?? state.after; if (!state.before) { state.before = report.before; state.hasOlder = report.hasOlder === true; } }
      else { state.before = report.before ?? state.before; state.hasOlder = report.hasOlder === true; }
      state.more = !older && report.hasMore === true; state.delay = report.active.length ? 1800 : 7000;
    } catch { if (!stopped && state.controller === controller && !document.hidden) { state.failed = true; state.delay = Math.min((state.delay || 2000) * 2, 30000); } }
    finally { clearTimeout(deadline); if (state.controller === controller) { state.inflight = false; state.controller = null; draw(state); clearTimeout(state.timer); if (!stopped) state.timer = setTimeout(() => void load(state), state.more ? 50 : state.delay || 2000); } }
  }
  const pause = () => { for (const state of cache.values()) { clearTimeout(state.timer); clearTimeout(state.leaseTimer); state.controller?.abort(); state.controller = null; state.inflight = false; } };
  document.addEventListener('visibilitychange', () => { pause(); if (!document.hidden) for (const state of cache.values()) void load(state); });
  document.addEventListener('queue-partner-open', () => { for (const state of cache.values()) void load(state); });
  window.addEventListener('pagehide', () => { stopped = true; pause(); }); window.addEventListener('pageshow', () => { stopped = false; for (const state of cache.values()) void load(state); });
  return (runId: string, host: HTMLElement) => {
    if (!uuid.test(runId)) return;
    let state = cache.get(runId); if (!state) { state = { runId, steps: [], expanded: new Set(), delay: 2000 }; cache.set(runId, state); }
    state.host = host; draw(state); if (!state.timer && !state.inflight) void load(state);
  };
}
