import assert from "node:assert/strict";
import test from "node:test";
import { approvedPromotions, createPromotionQueue, decidePromotions, markPromotionApplied, parsePromotionIds, pendingPromotions } from "./index.js";

test("createPromotionQueue initializes items as pending", () => {
  const queue = createPromotionQueue("tuning", "/proj", [
    { id: "t1", kind: "tuning", title: "Tune 1", description: "d", payload: {}, sourceHash: "abc" },
  ]);
  assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0].status, "pending");
});

test("decidePromotions approves matching pending items", () => {
  const queue = createPromotionQueue("learning", "/proj", [
    { id: "l1", kind: "learning", title: "L1", description: "d", payload: {}, sourceHash: "a" },
    { id: "l2", kind: "learning", title: "L2", description: "d", payload: {}, sourceHash: "b" },
  ]);
  const result = decidePromotions(queue, { ids: ["l1"], status: "approved", reviewer: "jason" });
  assert.equal(result.decided, 1);
  assert.equal(result.skipped, 0);
  assert.equal(result.queue.items[0].status, "approved");
  assert.equal(result.queue.items[0].decidedBy, "jason");
  assert.equal(result.queue.items[1].status, "pending");
});

test("decidePromotions with all targets every pending item", () => {
  const queue = createPromotionQueue("agent-improvement", "/proj", [
    { id: "a1", kind: "agent-improvement", title: "A1", description: "d", payload: {}, sourceHash: "a" },
    { id: "a2", kind: "agent-improvement", title: "A2", description: "d", payload: {}, sourceHash: "b" },
  ]);
  const result = decidePromotions(queue, { ids: "all", status: "rejected" });
  assert.equal(result.decided, 2);
  assert.ok(result.queue.items.every((i) => i.status === "rejected"));
});

test("decidePromotions skips non-pending items", () => {
  const queue = createPromotionQueue("tuning", "/proj", [
    { id: "t1", kind: "tuning", title: "T1", description: "d", payload: {}, sourceHash: "a" },
  ]);
  const once = decidePromotions(queue, { ids: ["t1"], status: "approved" });
  const twice = decidePromotions(once.queue, { ids: ["t1"], status: "rejected" });
  assert.equal(twice.decided, 0);
  assert.equal(twice.skipped, 1);
  assert.equal(twice.queue.items[0].status, "approved");
});

test("markPromotionApplied transitions approved to applied", () => {
  const queue = createPromotionQueue("tuning", "/proj", [
    { id: "t1", kind: "tuning", title: "T1", description: "d", payload: {}, sourceHash: "a" },
  ]);
  const decided = decidePromotions(queue, { ids: ["t1"], status: "approved" });
  const applied = markPromotionApplied(decided.queue, "t1");
  assert.equal(applied.items[0].status, "applied");
  assert.ok(applied.items[0].appliedAt);
});

test("approvedPromotions and pendingPromotions filter correctly", () => {
  const queue = createPromotionQueue("learning", "/proj", [
    { id: "l1", kind: "learning", title: "L1", description: "d", payload: {}, sourceHash: "a" },
    { id: "l2", kind: "learning", title: "L2", description: "d", payload: {}, sourceHash: "b" },
  ]);
  const decided = decidePromotions(queue, { ids: ["l1"], status: "approved" });
  assert.equal(approvedPromotions(decided.queue).length, 1);
  assert.equal(pendingPromotions(decided.queue).length, 1);
});

test("parsePromotionIds handles all and lists", () => {
  assert.equal(parsePromotionIds(undefined), "all");
  assert.equal(parsePromotionIds("all"), "all");
  assert.deepEqual(parsePromotionIds("a,b, c"), ["a", "b", "c"]);
});
