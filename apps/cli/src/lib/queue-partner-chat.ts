import { createHash, randomUUID } from "node:crypto";
import { sanitizeAssistantText, parseConversationRequest, type ConversationTurn } from "../../../../packages/conversation-contract/src/index.js";

export type PartnerItem = { runId: string; projectId: string; projectName?: string; familyId?: string; title: string; originalDeliverable?: string; currentAction?: string; status: string; blocker: string; proposedFix: string; approvalCount: number; completedStages?: number; totalStages?: number; remainingStages?: number; runningTasks?: number; latestActivityAt?: string; queueTrendDelta?:number; queueTrendTone?:'positive'|'warning'|'neutral'; queueTrendAction?:string };
export type PartnerApproval = { id: string; runId: string; projectId: string; status: string; actionType: string; target: string; payload: unknown };
export type PartnerProposal = { id: string; conversationId: string; projectId: string; runId: string; approvalId: string; approvalHash: string; summary: string; disclosure: string; expiresAt: string };
export type PartnerActionResult = { status: "queued" | "completed" | "requested" | "blocked"; text: string; runId?: string };
export type PartnerReply = {
  kind: "queue_partner_chat_report"; status: "answered" | "needs-selection" | "needs-approval" | "review" | PartnerActionResult["status"];
  text: string; items: PartnerItem[]; selectedRunId?: string; proposal?: PartnerProposal; runId?: string; replayed?: boolean;
};
export type PartnerMessage = { projectId?: string; conversationId: string; message: string; idempotencyKey: string; history: ConversationTurn[]; runId?: string; proposalId?: string };
export interface PartnerChatAdapter {
  canAct?(projectId?: string): boolean | Promise<boolean>;
  onceMessage?(message: PartnerMessage, action: () => Promise<PartnerReply>): Promise<PartnerReply>;
  items(): Promise<PartnerItem[]>;
  item(runId: string): Promise<PartnerItem | null>;
  approvals(runId: string): Promise<PartnerApproval[]>;
  approval(id: string): Promise<PartnerApproval | null>;
  saveProposal(proposal: PartnerProposal): Promise<void>;
  proposal(id: string): Promise<PartnerProposal | null>;
  once(key: string, requestHash: string, runId: string, action: () => Promise<PartnerReply>): Promise<PartnerReply>;
  repair(item: PartnerItem, message: string): Promise<PartnerActionResult>;
  stop?(item: PartnerItem, message: string): Promise<PartnerActionResult>;
  approve(approval: PartnerApproval): Promise<PartnerActionResult>;
  converse(message: PartnerMessage): Promise<string>;
  now?(): number;
}

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu;
export function isPartnerStatusMessage(message:string):boolean {
  const text=message.trim().toLowerCase().replace(/[.!?]+$/u,'').replace(/^(?:please\s+|(?:can|could|would) you\s+)/u,'');
  return /^(?:(?:show|give me) (?:the )?)?(?:(?:current|queue|work) )?status(?: update)?(?: please)?$/u.test(text)
    || /^(?:what is|what's) (?:the )?(?:current |queue |work )?status$/u.test(text)
    || /^(?:how is|how's) (?:it going|(?:the )?(?:queue|work) doing)$/u.test(text);
}

function partnerStatusText(items:PartnerItem[],selected:PartnerItem|null,at:number):string {
  const count=(states:string[])=>items.filter(item=>states.includes(item.status)).length;
  const safe=(value:unknown,max:number)=>sanitizeAssistantText(value,max);
  const openStates=['running','leased','queued','blocked','failed'];
  const attention=items.filter(item=>openStates.includes(item.status)).sort((a,b)=>Number(!['running','leased'].includes(a.status))-Number(!['running','leased'].includes(b.status)));
  const lines=[`Current recorded queue: ${items.length} item${items.length===1?'':'s'} — ${count(['running','leased'])} active, ${count(['queued'])} queued, ${count(['blocked'])} blocked, ${count(['failed'])} failed, ${count(['completed'])} completed, ${count(['cancelled'])} cancelled.`,
    `Observed ${new Date(at).toISOString()}. Workflow state and independently verified product acceptance remain separate.`];
  if(selected)lines.push(`Selected: ${safe(selected.title,180)} (${selected.runId.slice(0,8)})\nState: ${safe(selected.status,30)}${selected.currentAction?`\nCurrent action: ${safe(selected.currentAction,180)}`:''}${selected.blocker?`\nBlocker: ${safe(selected.blocker,600)}`:''}${openStates.includes(selected.status)&&selected.proposedFix?`\nNext: ${safe(selected.proposedFix,400)}`:''}${selected.approvalCount?`\nRecorded approval entries: ${selected.approvalCount}; review the exact current requests.`:''}`);
  else if(attention.length)lines.push(...attention.slice(0,5).map(item=>`- ${safe(item.title,160)}${item.projectName?` — ${safe(item.projectName,60)}`:''} (${item.runId.slice(0,8)}): ${safe(item.status,24)}${item.blocker?`\nBlocker: ${safe(item.blocker,220)}`:''}`));
  else lines.push(items.length?'No active, queued, blocked or failed items are visible in this snapshot.':'No work items are visible in this queue snapshot.');
  if(items.length>=500)lines.push('The queue snapshot is capped at 500 items.');
  return lines.join('\n\n');
}

export function partnerHash(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

/** Full material payload for the trusted local operator; never silently truncate or disclose credentials. */
export function partnerApprovalDisclosure(approval:PartnerApproval):string|null{
 const text=JSON.stringify({actionType:approval.actionType,target:approval.target,payload:approval.payload},null,2);
 if(text.length>12000||/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b|\bBearer\s+\S+|\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+|"(?:[^"\s]*[_-])?(?:api[_-]?key|password|secret|token|authorization|credentials?)"\s*:\s*"[^"\s]+"/iu.test(text))return null;
 return text;
}

export function parsePartnerMessage(value: unknown): PartnerMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("A message object is required.");
  const body = value as Record<string, unknown>;
  // The generic conversation contract still needs a routing context. This sentinel
  // is parsing-only, never a project identity or authority for an action.
  const parsed = parseConversationRequest({ ...body, projectId: body.projectId === undefined ? "queue" : body.projectId, actor: "dashboard-user", actorRole: "operator", capabilityMode: "conversation", assistantMode: "queue-partner" });
  if (typeof body.conversationId !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/u.test(body.conversationId)) throw Error("A bounded conversation id is required.");
  for (const field of ["runId", "proposalId"]) if (body[field] !== undefined && (typeof body[field] !== "string" || !uuid.test(body[field] as string))) throw Error(`Invalid ${field}.`);
  return { ...(body.projectId !== undefined ? { projectId: parsed.projectId } : {}), conversationId: body.conversationId, message: parsed.message, idempotencyKey: parsed.idempotencyKey, history: parsed.history,
    ...(body.runId ? { runId: String(body.runId) } : {}), ...(body.proposalId ? { proposalId: String(body.proposalId) } : {}) };
}

export function proposedQueueFix(blocker: string, approvals: number): string {
  if (approvals) return "Review the exact pending action, approve it if appropriate, then continue the existing work.";
  if (/preimage|hunk|checkout.*mismatch|stale.*source/iu.test(blocker)) return "Refresh the exact source baseline, merge the correction, and rerun the focused verification.";
  if (/receipt|contract|enrollment|provenance/iu.test(blocker)) return "Recover authentic source and receipt evidence, then assess a bounded repair without rewriting history.";
  if (/native|physical|hardware|voiceover|human acceptance/iu.test(blocker)) return "Complete available offline checks and obtain the missing actual-host or human evidence; do not simulate a pass.";
  if (/test|assert|command.*fail|exit.*[1-9]/iu.test(blocker)) return "Reproduce the failing check, repair the demonstrated cause, and independently rerun the required gate.";
  return "Inspect the failure evidence, repair the owning project within policy, and verify the intended outcome.";
}

/** Delivery order is evidence-based advice only. It never bypasses project policy, approvals, scopes, or coordinator gates. */
export function rankPartnerItems(items: PartnerItem[]): PartnerItem[] {
  const blockerCounts = new Map<string, number>();
  for (const item of items) {
    const key = item.blocker.trim().toLowerCase().replace(/\b[0-9a-f]{8,}\b/gu, "#").slice(0, 180);
    if (key) blockerCounts.set(key, (blockerCounts.get(key) ?? 0) + 1);
  }
  const score = (item: PartnerItem): number => {
    const status = item.status.toLowerCase();
    const remaining = Number.isFinite(item.remainingStages) ? Math.max(0, item.remainingStages ?? 0) : 100;
    const completion = item.totalStages ? Math.max(0, Math.min(1, (item.completedStages ?? 0) / item.totalStages)) : 0;
    const blockerKey = item.blocker.trim().toLowerCase().replace(/\b[0-9a-f]{8,}\b/gu, "#").slice(0, 180);
    return ({ running: 700, leased: 650, failed: 480, blocked: 450, queued: 300 }[status] ?? 0)
      + (item.approvalCount ? -500 : 100)
      + completion * 180
      + Math.max(0, 140 - remaining * 20)
      + (item.queueTrendTone==='warning'?Math.min(240,Math.max(0,item.queueTrendDelta??0)*60):0)
      + Math.max(0, (blockerCounts.get(blockerKey) ?? 1) - 1) * 75;
  };
  const timestamp = (item: PartnerItem) => Number.isFinite(Date.parse(item.latestActivityAt ?? "")) ? Date.parse(item.latestActivityAt ?? "") : 0;
  return [...items].sort((a, b) => score(b) - score(a) || timestamp(a) - timestamp(b) || a.projectId.localeCompare(b.projectId) || a.runId.localeCompare(b.runId));
}

/** Operator preference changes ranking only, never eligibility, ownership, scope or evidence. */
export function prioritizePartnerRequests<T extends { projectId: string; sourceRunId: string; priority?: number }>(families: T[], requests: Array<{ projectId: string; runId: string }>): T[] {
  const requested = new Set(requests.map(r => `${r.projectId}:${r.runId}`));
  return families.map(family => requested.has(`${family.projectId}:${family.sourceRunId}`) ? { ...family, priority: (family.priority ?? 0) + 1000 } : family);
}

/** Only authenticated controller code interprets commands. Model/history text never approves or dispatches. */
export async function processPartnerMessage(input: PartnerMessage, adapter: PartnerChatAdapter): Promise<PartnerReply> {
  const now = () => adapter.now?.() ?? Date.now();
  const normalized = input.message.trim().toLowerCase().replace(/[.!?]+$/u, "").replace(/^(?:please\s+|(?:can|could|would) you\s+)/u, "");
  const approve = /^(?:approved|approve(?: it| this| this one)?|yes,? approved|approve and (?:run|execute))$/u.test(normalized);
  const next = /^(?:(?:pick up|pick|take|start|work on)\s+)(?:the\s+)?next\s+(?:blocked\s+)?(?:item|issue|task)(?:\s+please)?$/u.test(normalized);
  const fix = /^(?:fix|repair|resolve)\b/u.test(normalized);
  const stop = /^(?:stop|cancel)(?: this| the| selected)? (?:work|run)$/u.test(normalized);
  const list = /^(?:list|show|give me)\b[\s\S]*\b(?:items|queue|blockers|blocked|fixes)\b/u.test(normalized) || /^(?:what needs attention|why is work blocked|what can be repaired safely)$/u.test(normalized);
  const reply = (status: PartnerReply["status"], text: string, extra: Partial<PartnerReply> = {}): PartnerReply => ({ kind: "queue_partner_chat_report", status, text: sanitizeAssistantText(text), items: [], ...extra });
  // Claim the operator request BEFORE selection. A queue change on retransmission
  // must not move one instruction into a second project's independent ledger.
  if ((approve || fix || next || stop) && adapter.onceMessage) return adapter.onceMessage(input, () => processPartnerMessage(input, {...adapter, onceMessage:undefined}));
  const canAct = async (projectId?: string) => !adapter.canAct || await adapter.canAct(projectId);
  if ((approve || fix || next || stop) && !await canAct(input.projectId)) return reply("blocked", "The configured dashboard role is read-only or cannot request actions. Queue questions and lists are still available.");

  if (approve && input.proposalId) {
    const proposal = await adapter.proposal(input.proposalId);
    if (!proposal || (input.projectId && proposal.projectId !== input.projectId) || proposal.conversationId !== input.conversationId || (input.runId && input.runId !== proposal.runId)) {
      return reply("blocked", "That approval does not belong to this conversation, project and item. Show the current proposal first.");
    }
    if (!await canAct(proposal.projectId)) return reply("blocked", "The owning project's identity, local access or configured role does not allow this action. No approval was applied.");
    // A prior settled response is replayable; a fresh effect must revalidate the live approval below.
    return adapter.once(`approval:${proposal.id}`, partnerHash(proposal), proposal.runId, async () => {
      if (!Number.isFinite(Date.parse(proposal.expiresAt)) || Date.parse(proposal.expiresAt) <= now()) return reply("blocked", "The proposal expired. Review a fresh proposal before approving.");
      const current = await adapter.approval(proposal.approvalId);
      if (!current || current.projectId !== proposal.projectId || current.runId !== proposal.runId || !["pending", "approved"].includes(current.status) || partnerHash(current) !== proposal.approvalHash || partnerApprovalDisclosure(current)!==proposal.disclosure || !await canAct(proposal.projectId)) {
        return reply("blocked", "The pending action changed or is no longer available. Nothing was approved; review a fresh proposal.");
      }
      const result = await adapter.approve(current);
      return reply(result.status, result.text, { selectedRunId: proposal.runId, ...(result.runId ? { runId: result.runId } : {}) });
    });
  }

  const items = rankPartnerItems((await adapter.items()).filter(item => !input.projectId || item.projectId === input.projectId)).slice(0, 500);
  const actionable = items.filter(item => ["blocked", "failed"].includes(item.status));
  let selected = input.runId ? await adapter.item(input.runId) : null;
  if (input.runId && (!selected || (input.projectId && selected.projectId !== input.projectId))) return reply("blocked", "This item is unavailable or does not belong to the explicit project filter. Choose an item from the queue.", { items });
  if(isPartnerStatusMessage(input.message))return reply('answered',partnerStatusText(items,selected,now()),{items,...(selected?{selectedRunId:selected.runId}:{})});
  if (stop) {
    // Stop never chooses a run from prose, transcript history, or queue order.
    if (!input.runId || !selected) return reply("needs-selection", "Select the exact active run to stop. No work was cancelled.", { items });
    if (!adapter.stop || !await canAct(selected.projectId)) return reply("blocked", "This owning project does not permit the requested stop.", { items, selectedRunId: selected.runId });
    const item = selected;
    return adapter.once(`stop:${input.conversationId}:${input.idempotencyKey}`, partnerHash(input), item.runId, async () => {
      const fresh = await adapter.item(item.runId);
      if (!fresh || fresh.projectId !== item.projectId || !['queued', 'leased', 'running'].includes(fresh.status) || !await canAct(fresh.projectId)) return reply('blocked', 'This run is no longer active or its owning-project access changed. No stop was applied.', { selectedRunId: item.runId });
      const result = await adapter.stop!(fresh, input.message);
      return reply(result.status, result.text, { items, selectedRunId: fresh.runId, runId: fresh.runId });
    });
  }
  if (next) {
    const eligible: PartnerItem[] = [];
    for (const item of actionable) if (await canAct(item.projectId)) eligible.push(item);
    const remaining = eligible.filter(item => item.runId !== selected?.runId);
    selected = remaining.find(item => item.approvalCount === 0) ?? remaining[0] ?? eligible.find(item => item.runId === selected?.runId) ?? null;
  }
  if (!selected && (fix || approve) && actionable.length === 1) selected = actionable[0];

  if (list) {
    const text = actionable.length ? actionable.map((item, index) => `${index + 1}. ${item.title}${item.projectName ? ` — ${item.projectName}` : ""} (${item.runId.slice(0, 8)})\nBlocker: ${item.blocker || "Inspect the recorded failure evidence."}\nProposed fix: ${item.proposedFix}`).join("\n\n") : "No blocked or failed items are visible in the current queue.";
    return reply("answered", text, { items, ...(selected ? { selectedRunId: selected.runId } : {}) });
  }

  if (fix || next || approve) {
    if (!selected) return reply("needs-selection", actionable.length ? "Choose the item you mean, or say ‘pick up the next blocked item’. Items without owning-project access remain visible but cannot be dispatched." : "No blocked item is available in the current queue.", { items });
    if (!await canAct(selected.projectId)) return reply("blocked", "This item's owning project is read-only, unavailable locally or not a verified canonical registration. Resolve that exact access or identity issue before acting.", { items, selectedRunId: selected.runId });
    if (!["blocked", "failed"].includes(selected.status)) return reply("blocked", `This item is ${selected.status}; I did not start a duplicate repair.`, { items, selectedRunId: selected.runId });
    const approvals = (await adapter.approvals(selected.runId)).filter(a => a.projectId === selected!.projectId && a.runId === selected!.runId && ["pending", "approved"].includes(a.status));
    if (approvals.length) {
      if (approvals.length !== 1) return reply("needs-selection", "This item has multiple pending actions. Review and select one exact action in its approval list; ‘approved’ cannot approve them all.", { items, selectedRunId: selected.runId });
      const approval = approvals[0];
      const disclosure=partnerApprovalDisclosure(approval);
      if(disclosure===null)return reply("needs-selection","This action is too large or contains sensitive material that cannot be disclosed completely in chat. Review its exact payload in the approval list; inline approval was not enabled.",{items,selectedRunId:selected.runId});
      const proposal: PartnerProposal = { id: randomUUID(), conversationId: input.conversationId, projectId: selected.projectId, runId: selected.runId, approvalId: approval.id,
        approvalHash: partnerHash(approval), summary: sanitizeAssistantText(`${approval.actionType}: ${approval.target}`, 1000), disclosure, expiresAt: new Date(now() + 10 * 60_000).toISOString() };
      await adapter.saveProposal(proposal);
      return reply("needs-approval", `This exact action needs approval: ${proposal.summary}\nAction ${approval.id}; item ${selected.runId.slice(0, 8)}. Review the full recorded payload below. ‘Approved’ authorizes execution under current policy, not just recording consent; it does not accept the product outcome.`, { items, selectedRunId: selected.runId, proposal });
    }
    if (approve) return reply("blocked", "There is no current approval proposal for this item. ‘Approved’ did not start or approve anything.", { items, selectedRunId: selected.runId });
    const item = selected;
    return adapter.once(`repair:${input.conversationId}:${input.idempotencyKey}`, partnerHash(input), item.runId, async () => {
      const fresh = await adapter.item(item.runId);
      if (!fresh || fresh.projectId !== item.projectId || !["blocked", "failed"].includes(fresh.status) || fresh.approvalCount || !await canAct(fresh.projectId)) return reply("blocked", "The item changed or now needs approval. Refresh the queue before continuing.");
      const result = await adapter.repair(fresh, input.message);
      return reply(result.status, result.text, { items, selectedRunId: fresh.runId, ...(result.runId ? { runId: result.runId } : {}) });
    });
  }

  const text = await adapter.converse(input);
  return reply("answered", text, { items, ...(selected ? { selectedRunId: selected.runId } : {}) });
}
