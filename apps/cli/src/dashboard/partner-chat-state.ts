/** Browser-local conversation state. Restoring a transcript never replays a request. */
export const PARTNER_CHAT_LIMITS = { chats: 8, turns: 48, characters: 96000, storage: 1000000 } as const;
export type PartnerChatTurn = { id: string; role: 'user' | 'assistant'; text: string; detail?: string; state?: string; runId?: string; disclosure?: string; proposalId?: string; observation?: boolean; activityKey?: string; items?: Array<{runId:string;title:string;status:string}> };
export type PartnerChatThread = { id: string; title: string; draft: string; turns: PartnerChatTurn[]; selectedRunId: string | null; proposal: any; updatedAt: number; workRefs?: Array<{runId:string;anchorTurnId:string|null}> };
export type PartnerChatState = { version: 1; scope: string; activeId: string; threads: PartnerChatThread[] };

export function partnerChatHistory(turns: PartnerChatTurn[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const turn of turns) {
    if (turn.observation || turn.state && turn.state !== 'complete') continue;
    history.push({ role: turn.role, content: turn.text.slice(0, 4000) });
    while (history.length > 10 || history.reduce((size, item) => size + item.content.length, 0) > 24000) history.shift();
  }
  return history;
}

/** Self-contained so the same validation runs in the browser and in tests. */
export function restorePartnerChats(raw: string | null, scope: string): PartnerChatState | null {
  if (!raw || raw.length > 1000000) return null;
  try {
    const value = JSON.parse(raw), uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
    if (value?.version !== 1 || value.scope !== scope || !Array.isArray(value.threads)) return null;
    const seen = new Set<string>();
    const threads = value.threads.slice(0, 8).flatMap((thread: any) => {
      if (!thread || typeof thread.id !== 'string' || !uuid.test(thread.id) || seen.has(thread.id) || !Array.isArray(thread.turns)) return [];
      seen.add(thread.id);
      let characters = 0;
      const turns: PartnerChatTurn[] = [];
      for (const turn of thread.turns.slice(-48).reverse()) {
        if (!turn || typeof turn.id !== 'string' || !uuid.test(turn.id) || !['user', 'assistant'].includes(turn.role) || typeof turn.text !== 'string') continue;
        const text = turn.text.slice(0, 12000), disclosure = typeof turn.disclosure === 'string' && turn.disclosure.length <= 12000 ? turn.disclosure : undefined;
        characters += text.length + (disclosure?.length ?? 0);
        if (characters > 96000) break;
        turns.unshift({ id: turn.id, role: turn.role, text, detail: typeof turn.detail === 'string' ? turn.detail.slice(0, 1000) : '',
          state: ['queued', 'sending'].includes(turn.state) ? 'unconfirmed' : ['complete', 'unconfirmed', 'cancelled'].includes(turn.state) ? turn.state : 'complete',
          ...(typeof turn.runId === 'string' && uuid.test(turn.runId) ? { runId: turn.runId } : {}), ...(disclosure ? { disclosure } : {}),
          ...(turn.observation === true ? { observation: true, activityKey: typeof turn.activityKey === 'string' ? turn.activityKey.slice(0,2000) : '' } : {}),
          ...(Array.isArray(turn.items) ? { items: turn.items.filter((item:any)=>item&&uuid.test(item.runId)&&typeof item.title==='string').slice(0,6).map((item:any)=>({runId:item.runId,title:item.title.slice(0,160),status:String(item.status??'').slice(0,30)})) } : {}) });
      }
      // Local history is not an authenticated current proposal. Preserve its
      // displayed payload, but require a fresh server proposal before consent.
      const proposal = null;
      return [{ id: thread.id, title: typeof thread.title === 'string' ? thread.title.slice(0, 80) : 'New conversation',
        draft: typeof thread.draft === 'string' ? thread.draft.slice(0, 4000) : '', turns,
        selectedRunId: typeof thread.selectedRunId === 'string' && uuid.test(thread.selectedRunId) ? thread.selectedRunId : null,
        proposal, updatedAt: typeof thread.updatedAt === 'number' && Number.isFinite(thread.updatedAt) ? thread.updatedAt : 0,
        workRefs: Array.isArray(thread.workRefs) ? thread.workRefs.filter((ref:any)=>ref&&uuid.test(ref.runId)).slice(-3).map((ref:any)=>({runId:ref.runId,anchorTurnId:typeof ref.anchorTurnId==='string'&&uuid.test(ref.anchorTurnId)?ref.anchorTurnId:null})) : [] }];
    });
    if (!threads.length) return null;
    return { version: 1, scope, activeId: threads.some((thread: PartnerChatThread) => thread.id === value.activeId) ? value.activeId : threads[0].id, threads };
  } catch { return null; }
}
