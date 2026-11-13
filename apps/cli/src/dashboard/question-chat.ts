import type http from "node:http";
import { dashboardPartnerChatScript } from './partner-chat-client.js';

type QuestionProject = { id: string; name: string; rootUri: string };
type ConversationSummary = {
  status: string;
  assistant: null | { text: string; actualProvider: string; actualModel: string | null; fallbackUsed: boolean };
  operation: null | { workflowId: string; runId: string | null };
  error?: string;
};

export function isTrustedLocalDashboardRequest(request: http.IncomingMessage): boolean {
  const remoteAddress = request.socket.remoteAddress ?? "";
  if (remoteAddress !== "::1" && remoteAddress !== "127.0.0.1" && remoteAddress !== "::ffff:127.0.0.1") return false;
  const host = firstHeader(request.headers.host);
  if (!host) return false;
  try {
    const sources = [new URL(`http://${host}`), ...[firstHeader(request.headers.origin), firstHeader(request.headers.referer)].filter((value): value is string => Boolean(value)).map((value) => new URL(value))];
    return sources.every((source) => source.hostname === "127.0.0.1" || source.hostname === "localhost" || source.hostname === "[::1]");
  } catch {
    return false;
  }
}

export function formatServerConversationReport(report: ConversationSummary): string {
  if (report.assistant) return `${report.assistant.text}\n\nProvider: ${report.assistant.actualProvider}/${report.assistant.actualModel ?? "default"}${report.assistant.fallbackUsed ? " (fallback)" : ""}`;
  if (report.operation) return `${report.status}: ${report.operation.workflowId}${report.operation.runId ? ` run=${report.operation.runId}` : " requires governed queue authorization"}`;
  return `blocked: ${report.error ?? "conversation request rejected"}`;
}

export function renderDashboardQuestionPanel(projects: QuestionProject[], defaultProjectRoot: string, context:{runId?:string}={}): string {
  const runId=context.runId&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(context.runId)?context.runId:'';
  return `<section class="ops-panel ops-question-panel" aria-labelledby="dashboard-question-heading" data-partner-run="${runId}">
    <h2 id="dashboard-question-heading" class="ops-chat-sr">Partner conversation</h2>
    <div class="ops-chat-toolbar"><label class="ops-chat-sr" for="dashboard-question-recent">Recent chats</label><select id="dashboard-question-recent" aria-label="Recent Partner chats"></select><button type="button" id="dashboard-question-new">New chat</button></div>
    <div id="dashboard-question-thread" class="ops-question-thread" role="log" aria-live="polite" aria-relevant="additions" aria-label="Queue partner conversation"></div>
    <button type="button" id="dashboard-question-jump" class="ops-chat-jump" hidden>Jump to latest</button>
    <form id="dashboard-question-form" class="ops-question-form"><label class="ops-question-input"><span class="ops-chat-sr">Message Queue Partner</span><textarea id="dashboard-question-message" name="message" rows="2" maxlength="4000" required placeholder="Message Partner…"></textarea></label><div class="ops-chat-send"><button type="button" id="dashboard-question-stop-wait" hidden>Stop waiting</button><button type="submit">Send</button></div></form>
    <div class="ops-chat-footnote"><span id="dashboard-question-observation" aria-live="off">Connecting to queue activity…</span></div>
    <div class="ops-chat-footnote"><span id="dashboard-question-status" role="status" aria-live="polite">Ready</span><span id="dashboard-question-storage">Saved in this browser</span></div>
  </section>${dashboardQuestionClientScript()}`;
}

function dashboardQuestionClientScript(): string {
  return dashboardPartnerChatScript();
}

function firstHeader(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}
