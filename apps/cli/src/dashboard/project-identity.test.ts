import assert from "node:assert/strict";
import test from "node:test";
import { logicalProjectIdentityKeys, type ProjectIdentityInput } from "./project-identity.js";

test("immutable release registrations group under one available mutable project", () => {
  const local = { project: { name: "agent-workflow", rootUri: "/Users/example/Projects/Agent Workflow" }, resolution: { storageRootUri: "/Users/example/Projects/Agent Workflow", localRootUri: "/Users/example/Projects/Agent Workflow", localPathExists: true } };
  const release = { project: { name: "agent-workflow", rootUri: "/home/example/releases/agent-workflow/deadbeef" }, resolution: { storageRootUri: "/home/example/releases/agent-workflow/deadbeef", localRootUri: "/home/example/releases/agent-workflow/deadbeef", localPathExists: false } };
  const keys = logicalProjectIdentityKeys([local, release] satisfies ProjectIdentityInput[]);
  assert.equal(keys.get(local), local.project.rootUri);
  assert.equal(keys.get(release), local.project.rootUri);
});

test("same-name mutable projects stay separate when identity is ambiguous", () => {
  const first = { project: { name: "app", rootUri: "/one/app" }, resolution: { storageRootUri: "/one/app", localRootUri: "/one/app", localPathExists: true } };
  const second = { project: { name: "app", rootUri: "/two/app" }, resolution: { storageRootUri: "/two/app", localRootUri: "/two/app", localPathExists: true } };
  const release = { project: { name: "app", rootUri: "/home/example/releases/app/deadbeef" }, resolution: { storageRootUri: "/home/example/releases/app/deadbeef", localRootUri: "/home/example/releases/app/deadbeef", localPathExists: false } };
  const keys = logicalProjectIdentityKeys([first, second, release] satisfies ProjectIdentityInput[]);
  assert.equal(keys.get(release), release.project.rootUri);
});
