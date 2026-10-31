import assert from "node:assert/strict";
import test from "node:test";
import { renderContextInfluenceHtml } from "./context-influence.js";
test("influence details escape evidence and preserve navigation and legacy status", () => {
  const base={schemaVersion:1,project:"/synthetic",runId:"run",authority:"none",meaning:"supplied",status:"not_recorded",truncated:false,receipts:[]};
  assert.match(renderContextInfluenceHtml(base),/cannot be attributed retrospectively/);
  const html=renderContextInfluenceHtml({...base,status:"available",receipts:[{id:"receipt",receiptHash:"hash",observedAt:"date",phase:"plan",metadata:{graphStatus:"not_supplied",references:[{key:"<script>",kind:"file",includedHash:"digest",freshness:"unverified",confidence:"recorded",observedAt:null,target:{type:"file",value:"requirements.md"}}]}}]});
  assert.ok(!html.includes("<script>"));assert.match(html,/&lt;script&gt;/);assert.match(html,/\/studio\/context\?project=/);assert.match(html,/not supplied/);assert.match(html,/Receipt chain hash/);
});
