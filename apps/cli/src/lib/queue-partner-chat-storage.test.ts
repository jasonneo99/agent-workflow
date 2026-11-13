import assert from "node:assert/strict";
import test from "node:test";
import type http from "node:http";
import { readFileSync } from "node:fs";
import { chainReceipt } from "../../../../packages/workflow-engine/src/receipt-chain.js";
import { isTrustedPartnerCommandRequest, partnerProposalReceiptMatches, partnerApprovalEffectMatches } from "./queue-partner-chat-storage.js";

const request = (headers: Record<string, string> = {}, remote = "127.0.0.1") => ({ socket: { remoteAddress: remote }, headers: { host: "localhost:17888", origin: "http://localhost:17888", "content-type": "application/json", "x-agentflow-queue-partner": "1", ...headers } }) as unknown as http.IncomingMessage;

test("commands require local same-origin JSON and the explicit custom-header boundary", () => {
  assert.equal(isTrustedPartnerCommandRequest(request()), true);
  for (const input of [request({}, "192.0.2.1"), request({ origin: "https://outside.invalid" }), request({ origin: "http://localhost:9999" }), request({ origin: "https://localhost:17888" }), request({ "x-agentflow-queue-partner": "" }), request({ "content-type": "text/plain" }), request({ referer: "https://outside.invalid/page" })]) assert.equal(isTrustedPartnerCommandRequest(input), false);
});

test('completed action needs its exact applied artifact and authentic receipt, never just an executed flag',()=>{
 const runId='11111111-1111-4111-8111-111111111111',approvalId='22222222-2222-4222-8222-222222222222';
 const metadata={approvalId,actionType:'local_command',status:'executed',artifactUri:'db://synthetic/effect'};
 const receipt=chainReceipt('b'.repeat(64),{runId,agentId:'implementation-agent',actionType:'action_approval_executed',target:'npm run check',summary:'Command exited 0',metadata:JSON.stringify(metadata),metadataSerializationVersion:2,createdAt:'2026-01-01T00:00:00.123Z'});
 const row={status:'executed',approval_id:approvalId,approval_action:'local_command',approval_target:receipt.target,run_id:runId,agent_id:receipt.agentId,target:receipt.target,summary:receipt.summary,metadata,artifact_uri:metadata.artifactUri,kind:'command_output',content:{exitCode:0,timedOut:false},created_at:new Date(receipt.createdAt),metadata_serialization_version:2,prev_hash:receipt.prevHash,receipt_hash:receipt.receiptHash};
 assert.equal(partnerApprovalEffectMatches(row),true);
 for(const patch of [{status:'approved'},{kind:'lifecycle_skipped'},{kind:'lifecycle_action'},{content:{skipped:true}},{content:{exitCode:1}},{content:{exitCode:0,timedOut:true}},{approval_id:'foreign'},{artifact_uri:'db://synthetic/foreign'},{receipt_hash:'corrupt'},{metadata_serialization_version:1},{approval_action:'deployment'}])assert.equal(partnerApprovalEffectMatches({...row,...patch}),false);
});

test("proposal must match an authentic exact version-two receipt, not a bare artifact", () => {
  const runId = "11111111-1111-4111-8111-111111111111", proposal = { id: "proposal-one", projectId: "project-a", runId, approvalHash: "exact-hash" };
  const receipt = chainReceipt("a".repeat(64), { runId, agentId: "workflow-orchestrator", actionType: "queue_partner_approval_proposed", target: proposal.id, summary: "Exact proposal", metadata: JSON.stringify(proposal), metadataSerializationVersion: 2, createdAt: "2026-01-01T00:00:00.123Z" });
  const row = { target: receipt.target, summary: receipt.summary, metadata: proposal, created_at: receipt.createdAt, metadata_serialization_version: 2, prev_hash: receipt.prevHash, receipt_hash: receipt.receiptHash };
  assert.equal(partnerProposalReceiptMatches(runId, proposal, row), true);
  assert.equal(partnerProposalReceiptMatches(runId, proposal, { ...row, created_at: new Date(receipt.createdAt) }), true);
  for (const change of [{ metadata: { ...proposal, approvalHash: "changed" } }, { target: "other-proposal" }, { summary: "changed" }, { receipt_hash: "" }, { metadata_serialization_version: 1 }, { created_at: "invalid" }]) assert.equal(partnerProposalReceiptMatches(runId, proposal, { ...row, ...change }), false);
  assert.equal(partnerProposalReceiptMatches("foreign-run", proposal, row), false);
});
test('admission effects appear only with their exact applied artifact and execution receipt',()=>{
 const runId='11111111-1111-4111-8111-111111111111',approvalId='22222222-2222-4222-8222-222222222222';
 const metadata={approvalId,actionType:'partner_recovery_admission',status:'executed',artifactUri:'db://synthetic/admission'};
 const receipt=chainReceipt('b'.repeat(64),{runId,agentId:'workflow-orchestrator',actionType:'action_approval_executed',target:'synthetic-family:hash',summary:'Admission applied',metadata:JSON.stringify(metadata),metadataSerializationVersion:2,createdAt:'2026-01-01T00:00:00.123Z'});
 const row={status:'executed',approval_id:approvalId,approval_action:'partner_recovery_admission',approval_target:receipt.target,run_id:runId,agent_id:receipt.agentId,target:receipt.target,summary:receipt.summary,metadata,artifact_uri:metadata.artifactUri,kind:'partner_recovery_admission',content:{acceptance:'unverified'},created_at:new Date(receipt.createdAt),metadata_serialization_version:2,prev_hash:receipt.prevHash,receipt_hash:receipt.receiptHash};
 assert.equal(partnerApprovalEffectMatches(row),true);
 assert.equal(partnerApprovalEffectMatches({...row,kind:'action_approval'}),false);
 assert.equal(partnerApprovalEffectMatches({...row,status:'approved'}),false);
});

test("production integration scopes storage, retains claims and does not bypass managed recovery", () => {
  const source = readFileSync(new URL("./queue-partner-chat-storage.ts", import.meta.url), "utf8");
  assert.match(source, /r\.project_id=\$1::uuid/);
  assert.match(source, /acquireWorkIntent[\s\S]+runtime\/queue-partner\/instructions[\s\S]+releaseWorkIntent/);
  assert.match(source, /claimSideEffect[\s\S]+claimToken: claim.claimToken/);
  assert.match(source, /Never clear or refund an uncertain claim/);
  assert.match(source, /assertGenericRunRecoveryAllowed/);
  assert.match(source, /queue_partner_operator_repair_requested/);
  assert.match(source, /state\.metadata\.suiteId/);
  assert.doesNotMatch(source, /cancelWorkflowRun|retryFailedWorkflowRun|requeueRunning|delete from/i);
  const daemon = readFileSync(new URL("../commands/daemon.ts", import.meta.url), "utf8");
  const route = daemon.slice(daemon.indexOf('requestUrl.pathname === "/api/queue-partner-message"'), daemon.indexOf('requestUrl.pathname === "/api/server-conversation"'));
  assert.ok(route.indexOf("isTrustedPartnerCommandRequest") < route.indexOf("parsePartnerMessage"));
  assert.match(route, /resolveServerProjectReference/); assert.match(route, /config.team.default_actor_role/);
  assert.match(route, /approveAndExecuteAction/); assert.match(route, /processDashboardQueueAction/);
  assert.match(route,/await hasPartnerApprovalEffect\(projectId,approval.id\)/);
  assert.match(route,/createQueuePartnerAdapter/);assert.match(route,/loadPartnerProject\(projectId\)/);assert.match(route,/await partnerProjectAccess\(project\)/);
  assert.match(route,/items:readQueueItems,owner:queuePartnerOwner,adapter:adapterForProject/);
  assert.doesNotMatch(route, /actorRole: parsed\.actorRole|approveActorRole:.*approver"/);
});
