import type http from "node:http";
import escapeHtmlText from "escape-html";

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

export function renderDashboardQuestionPanel(projects: QuestionProject[], defaultProjectRoot: string): string {
  const defaultProject = projects.find((project) => project.rootUri === defaultProjectRoot) ?? projects[0] ?? null;
  const options = projects.map((project) => `<option value="${escapeHtmlText(project.id)}"${project.id === defaultProject?.id ? " selected" : ""}>${escapeHtmlText(project.name)}</option>`).join("");
  return `<section class="ops-panel ops-question-panel" aria-labelledby="dashboard-question-heading">
    <div class="ops-panel-heading"><div><h2 id="dashboard-question-heading">Ask Agent Workflow</h2><span>Get an evidence-backed project answer without starting implementation work</span></div><span id="dashboard-question-status" class="ops-question-status" aria-live="polite">Ready</span></div>
    <div id="dashboard-question-thread" class="ops-question-thread" role="log" aria-live="polite" aria-label="Question and answer history"><div class="ops-question-empty"><strong>Ask about a project</strong><span>Try “What is blocked?”, “How does approval work?”, or “What is next on the roadmap?”</span></div></div>
    <form id="dashboard-question-form" class="ops-question-form"><label>Project<select id="dashboard-question-project" name="projectId" required>${options}</select></label><label class="ops-question-input">Question<textarea id="dashboard-question-message" name="message" rows="2" maxlength="4000" required placeholder="Ask a question about this project"></textarea></label><button type="submit"${options ? "" : " disabled"}>Ask</button></form>
    <p class="ops-question-note">Questions are read-only. Requests to change state are handed back to a governed workflow.</p>
  </section>${dashboardQuestionClientScript()}`;
}

function dashboardQuestionClientScript(): string {
  return `<script>(()=>{const form=document.getElementById("dashboard-question-form"),thread=document.getElementById("dashboard-question-thread"),status=document.getElementById("dashboard-question-status"),message=document.getElementById("dashboard-question-message"),project=document.getElementById("dashboard-question-project");if(!form||!thread||!status||!message||!project)return;const history=[];const append=(role,text,detail)=>{thread.querySelector(".ops-question-empty")?.remove();const item=document.createElement("div"),label=document.createElement("strong"),body=document.createElement("p");item.className="ops-question-turn "+role;label.textContent=role==="user"?"You":"Agent Workflow";body.textContent=text;item.append(label,body);if(detail){const meta=document.createElement("small");meta.textContent=detail;item.append(meta)}thread.append(item);thread.scrollTop=thread.scrollHeight};form.addEventListener("submit",async event=>{event.preventDefault();const question=message.value.trim(),button=form.querySelector("button");if(!question||!project.value||!button)return;append("user",question,"");const priorHistory=history.slice(-10);history.push({role:"user",content:question});message.value="";message.disabled=true;button.disabled=true;status.textContent="Thinking…";try{const nonce=window.crypto&&window.crypto.randomUUID?window.crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2),response=await fetch("/api/server-conversation",{method:"POST",headers:{"content-type":"application/json",accept:"application/json"},body:JSON.stringify({message:question,history:priorHistory,idempotencyKey:"dashboard-"+nonce,actor:"dashboard-user",actorRole:"operator",projectId:project.value,capabilityMode:"conversation"})}),result=await response.json();if(result.assistant&&result.assistant.text){append("assistant",result.assistant.text,result.assistant.actualProvider+(result.assistant.actualModel?" · "+result.assistant.actualModel:""));history.push({role:"assistant",content:result.assistant.text});status.textContent="Answered"}else if(result.operation){const text="This request needs the governed "+result.operation.workflowId+" workflow. Use Start workflow to review and run it.";append("assistant",text,"No action was taken");history.push({role:"assistant",content:text});status.textContent="Workflow required"}else{append("assistant",result.error||"The question could not be answered.","No action was taken");status.textContent="Needs attention"}}catch{append("assistant","The dashboard could not reach the question service.","Check provider and dashboard status");status.textContent="Unavailable"}finally{message.disabled=false;button.disabled=false;message.focus()}})})()</script>`;
}

function firstHeader(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}
