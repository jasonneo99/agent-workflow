import escapeHtmlText from 'escape-html';
import type {QueuePartnerHistorySummary} from '../lib/queue-partner-memory.js';
const escape=(value:unknown)=>escapeHtmlText(String(value??''));
const duration=(ms:number)=>ms<1000?`${Math.round(ms)}ms`:ms<60000?`${(ms/1000).toFixed(ms<10000?1:0)}s`:`${Math.floor(ms/60000)}m ${Math.round(ms%60000/1000)}s`;
export function renderQueuePartnerHistory(summary:QueuePartnerHistorySummary|undefined):string{
 if(!summary?.attempts)return '';
 const items=summary.items.map(item=>`<li><a href="/run?id=${encodeURIComponent(item.runId)}">${escape(item.runId.slice(0,8))}</a> · <strong>${escape(item.proof.replaceAll('-',' '))}</strong>${item.durationMs===undefined?'':` · ${escape(duration(item.durationMs))}`}${item.costUsd===undefined?'':` · $${escape(item.costUsd.toFixed(4))}`}${item.bottleneck===undefined||item.bottleneckMs===undefined?'':`<small><strong>Slowest phase:</strong> ${escape(item.bottleneck.replaceAll('-',' '))} · ${escape(duration(item.bottleneckMs))}</small>`}<small>${escape(item.recordedAt)}</small>${item.influence?`<p><strong>Influence:</strong> ${escape(item.influence.effect.replaceAll('-',' '))} — ${escape(item.influence.reason)}</p>`:''}</li>`).join('');
 return `<details class="queue-learned-history"><summary>Learned history · ${summary.attempts} prior attempt${summary.attempts===1?'':'s'}${summary.verified?` · ${summary.verified} independently verified`:''}</summary><p class="muted">Evidence only. Prior attempts do not grant permission or prove the current run.</p><ol>${items}</ol></details>`;
}
