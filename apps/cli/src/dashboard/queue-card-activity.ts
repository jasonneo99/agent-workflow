/** Read-only DOM updates. Existing history, cards, focus and action controls are untouched. */
export function renderQueueCardActivityLine(runId:string,text:string):string{
 const escape=(s:string)=>s.replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;').replace(/"/gu,'&quot;').replace(/'/gu,'&#39;');
 const bounded=text.replace(/\s+/gu,' ').slice(0,320);
 return `<p class="queue-live-activity" role="status" aria-live="polite" aria-atomic="true" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0" title="${escape(bounded)}"><strong>Current action</strong> · <span data-queue-activity="${escape(runId)}">${escape(bounded)}</span></p>`;
}
export function queueCardActivityScript():string{return `
function updateQueueCardActivity(rows) {
 if (!Array.isArray(rows)) return;
 for (const row of rows.slice(0,100)) {
  if (!row || typeof row.runId !== 'string') continue;
  const value = Array.from(document.querySelectorAll('[data-queue-activity]')).find(el => el.dataset.queueActivity === row.runId);
  if (!value) continue;
  const activity = row.liveActivity;
  const text = activity && typeof activity.text === 'string' ? activity.text.replace(/\\s+/g,' ').slice(0,320) : 'Activity unavailable — inspect run history';
  if (value.textContent !== text) value.textContent = text;
  const line = value.closest('.queue-live-activity') || value;
  line.title = text + (activity?.observedAt ? ' · Recorded ' + String(activity.observedAt).slice(0,60) : '');
 }
}
`;}
