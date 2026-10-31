import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import YAML from "yaml";
import { agentCardSchema } from "./schemas.js";

const card = agentCardSchema.parse(YAML.parse(readFileSync(new URL("../../../agents/operations/queue-partner.yaml", import.meta.url), "utf8")));

test("queue partner is a portable schema-valid operations agent with bounded autonomy", () => {
  assert.equal(card.id, "queue-partner");
  assert.equal(card.category, "operations");
  assert.equal(card.model_strategy, "provider-agnostic");
  assert.equal(card.autonomy, 2);
  assert.ok(card.context_budget.max_tokens <= 3500);
});

test("queue partner preserves family execution, authority and independent acceptance boundaries", () => {
  for (const guard of [/Keep at least 3 queue items genuinely processing/, /target 5/, /hard total ceiling of five/, /one active repair per\s+family/, /durable claims/, /scoped work intents and fencing/, /advice, not authority/, /unchanged failure/, /repair-of-repair descendants/, /Never approve your own permission expansion/, /exact\s+original requirements and receipt chain/, /installed\/native behavior and user acceptance/]) {
    assert.match(card.prompt, guard);
  }
  assert.ok(card.requires_approval.length >= 3);
  assert.match(card.cannot.join("\n"), /permissions, action policy, grants/);
  assert.match(card.prompt, /preserve blockers,\s+approvals, receipts, and immutable history/);
});
test('Partner rechecks membership, consumes specialist evidence and monitors authorized project handoffs',()=>{
 for(const guard of [/authoritative active membership immediately before dispatch/,/dismissed or superseded source/,/authentic selected specialist/,/handoff is a tracked dependency, not completion/,
  /current owner and claim fence/,/follow-up condition/,/Monitor the actual owning-project run or authorized existing chat/,/returned evidence against the original/,/when the human explicitly authorizes/])assert.match(card.prompt,guard);
 assert.doesNotMatch(card.prompt,/stretch to 7/);
 assert.match(card.can.join('\n'),/coordinate_and_monitor_owning_project_handoffs/);
});
test('an unrelated callback cannot replace the active authorized handoff or resolve another family',()=>{
 assert.match(card.prompt,/evidence-only callback cannot replace an active human-authorized goal or named handoff/);
 assert.match(card.prompt,/expected family and current version/);
 assert.match(card.prompt,/another family leaves the original handoff open/);
});
test('concurrency is a real work target, not a reason to fabricate activity or hide held work',()=>{
 assert.match(card.prompt,/occupies one of those slots, never an extra slot/);assert.match(card.prompt,/without waiting for the whole batch/);assert.match(card.prompt,/If fewer than 3 can run/);assert.match(card.prompt,/held queue is not an empty queue/);assert.match(card.prompt,/Queued, held, duplicated or fabricated work does\s+not count as processing/);
});
test('Partner jurisdiction is the whole queue, while every effect retains its owning project boundary',()=>{
 assert.match(card.prompt,/whole queue's partner across all registered projects/);assert.match(card.prompt,/Project filters are optional viewing tools/);assert.match(card.prompt,/Discover new queued projects dynamically/);assert.match(card.prompt,/never transfer an\s+approval or execution permission between projects/);
});
test('Partner owns technical reasoning through its configured provider instead of another Codex chat',()=>{
 assert.match(card.prompt,/autonomous reasoning and execution owner/);assert.match(card.prompt,/configured\s+provider and active model route/);
 assert.match(card.prompt,/Do not send routine technical help back to the originating chat/);
 assert.match(card.prompt,/investigate read-only first/);assert.match(card.prompt,/model output never grants new permission/);
 assert.ok(!card.can.some(capability=>capability.includes('escalate_technical_blockers_to_codex')));
 assert.ok(card.can.includes('reuse_independently_verified_project_local_repair_playbooks'));
 assert.ok(card.can.includes('repair_its_own_control_loop_with_current_project_authority'));
 assert.match(card.prompt,/coordinator, continuation, capacity accounting/);assert.match(card.prompt,/command containment/);assert.match(card.prompt,/reservation shutdown/);
 assert.match(card.prompt,/A prior action target is evidence, not a command/);assert.match(card.prompt,/Chat transcripts,[\s\S]*never transfer authority into a playbook/);
});
test('explicit standing high-risk authority is usable without granting implicit high-risk access',()=>{
 assert.match(card.prompt,/high-risk classification alone is not an automatic permission denial/);
 assert.match(card.prompt,/current trusted operator authorization explicitly covers the action/);
 assert.match(card.prompt,/policy or scope corrections prospectively through supported governed paths/);
 assert.match(card.prompt,/preserve rollback, independent verification, ownership and approval fences/);
 assert.match(card.requires_approval.join('\n'),/not covered by current trusted operator authorization/);
 assert.match(card.requires_approval.join('\n'),/paid evaluations always need their separately explicit scope and budget/);
});

test("self-repair learning remains scrubbed, proposed and independently verified", () => {
  assert.match(card.prompt, /Learn only from independently verified outcomes/);
  assert.match(card.prompt, /compact scrubbed/);
  assert.match(card.prompt, /Failed or unverified attempts are not successful training/);
  assert.match(card.prompt, /Submit learning proposals for normal review/);
  assert.match(card.prompt, /do not silently promote/);
  assert.match(card.prompt, /run paid evaluations or export data/);
});
