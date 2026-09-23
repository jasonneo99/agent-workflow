import assert from "node:assert/strict";
import test from "node:test";
import { publicHttpError, serializeInlineScriptJson } from "./security.js";

test("inline script JSON cannot terminate its containing script", () => {
  const payload = serializeInlineScriptJson({ message: "</script><script>alert(1)</script>", separator: "\u2028" });
  assert.doesNotMatch(payload, /[<>&\u2028\u2029]/u);
  assert.match(payload, /\\u003c\/script\\u003e/u);
  assert.deepEqual(JSON.parse(payload), { message: "</script><script>alert(1)</script>", separator: "\u2028" });
});

test("public HTTP errors expose only stable caller-owned text", () => {
  const internal = new Error("password=secret /private/path stack detail");
  assert.equal(publicHttpError("Dashboard request failed."), "Dashboard request failed.");
  assert.doesNotMatch(publicHttpError("Dashboard request failed."), new RegExp(internal.message, "u"));
});
